// Integration tests of the smaller views and decorations: the status bar, the
// Git Repositories view, the decoration providers' less common paths, the
// HEAD documents of diffs, and the workspace helpers.
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { RepoEntry, RepoStore } from '../store';
import { HeadContentProvider, headUri } from '../views/headContent';
import { IGNORE_CONCURRENCY, IgnoredDecorationProvider } from '../views/ignoredDecorations';
import { ReposViewProvider } from '../views/reposView';
import { StatusBar } from '../views/statusBar';
import { toReposViewUri, toViewUri } from '../views/viewUri';
import { gitPath, localFolders, pickRows } from '../workspace';
import { at, stub, test, waitFor } from './harness';

type Item = { text: string; visible?: boolean; hide(): void; show(): void };

/** A store with just what the status bar reads. */
function fakeStore(repos: Partial<RepoEntry>[], active?: Partial<RepoEntry>, progress = { done: repos.length, total: repos.length }) {
  const none = () => ({ dispose() {} });
  return { all: () => repos, activeRepo: () => active, progress: () => progress, onDidChangeRepos: none, onDidDiscover: none } as unknown as RepoStore;
}

const view = (group: string, extra: object = {}) => ({ view: { group, branchLabel: 'main', tooltip: '', ahead: 0, behind: 0, ...extra } }) as unknown as Partial<RepoEntry>;

export function registerViewTests(): void {
  test('the status bar shows the active repo with ahead and behind, and totals by state', async () => {
    const texts = (bar: StatusBar) => {
      const items = bar as unknown as { current: Item; totals: Item };
      return [items.current.text, items.totals.text];
    };
    const cases: [Partial<RepoEntry>[], Partial<RepoEntry> | undefined, { done: number; total: number } | undefined, string[]][] = [
      [[view('clean'), view('clean')], { name: 'app', root: '/r', ...view('clean', { ahead: 2, behind: 1 }) }, undefined, ['$(git-branch) app: main ↑2 ↓1', '$(check) 2']],
      [[view('dirty'), view('conflict'), view('behind')], { name: 'app', root: '/r', ...view('clean', { behind: 3 }) }, { done: 1, total: 3 }, ['$(git-branch) app: main ↓3', '$(warning) 1  $(circle-filled) 1  $(arrow-down) 1  $(sync~spin) 1/3']],
      [[view('unpushed')], { name: 'app', root: '/r', ...view('clean') }, undefined, ['$(git-branch) app: main', '$(arrow-up) 1']],
    ];
    for (const [repos, active, progress, expected] of cases) {
      const bar = new StatusBar(fakeStore(repos, active, progress));
      try {
        assert.deepEqual(texts(bar), expected);
      } finally {
        bar.dispose();
      }
    }
    const empty = new StatusBar(fakeStore([], undefined));
    empty.dispose();
  });

  test('Git Repositories: rows know their group, repo rows have no children, and filtering works detached', async ({ store }) => {
    await waitFor('repos', () => store.get(at('services/search'))?.status);
    const provider = new ReposViewProvider(store);
    try {
      const repo = { type: 'repo' as const, root: at('services/search') };
      assert.deepEqual(provider.getParent(repo), { type: 'group', key: 'behind' });
      assert.equal(provider.getParent({ type: 'group', key: 'behind' }), undefined);
      assert.equal(provider.getParent({ type: 'repo', root: '/nowhere' }), undefined);
      assert.deepEqual(provider.getChildren(repo), []);
      provider.setFilter('search');
      assert.equal(provider.filter, 'search', 'no view to show it in, and no error');
      assert.equal((provider.getTreeItem(repo).resourceUri as vscode.Uri).toString(), toReposViewUri(at('services/search')).toString());
      // A workspace folder that is itself a repo, as when one repo is opened, is named by its folder.
      const self = store.get(at('services/search'))!;
      const restore = stub(store, 'get', (() => ({ ...self, root: process.env.SAMPLE_WORKSPACE!, name: 'sample-ws' })) as never);
      try {
        assert.equal(provider.getTreeItem({ type: 'repo', root: process.env.SAMPLE_WORKSPACE! }).label, 'sample-ws');
      } finally {
        restore();
      }
    } finally {
      provider.dispose();
    }
  });

  test('decorations of files inside untracked folders, of the built-in Explorer, and of repo roots', async ({ store, decorations }) => {
    const repo = at('frontend/web-app');
    mkdirSync(path.join(repo, 'brand-new', 'deep'), { recursive: true });
    writeFileSync(path.join(repo, 'brand-new', 'deep', 'x.ts'), '');
    const config = vscode.workspace.getConfiguration('multiGitExplorer');
    try {
      store.refresh(repo);
      await waitFor('the untracked folder', () => store.get(repo)?.changes?.has('brand-new/'));
      assert.equal(decorations.provideFileDecoration(toViewUri(path.join(repo, 'brand-new', 'deep', 'x.ts')))?.badge, 'U', 'from its untracked folder');
      assert.equal(decorations.provideFileDecoration(toViewUri(path.join(repo, 'README.md'))), undefined, 'unchanged');
      assert.equal(decorations.provideFileDecoration(vscode.Uri.file(repo)), undefined, 'the built-in Explorer is left alone by default');
      await config.update('decorateExplorer', true, vscode.ConfigurationTarget.Global);
      assert.ok(decorations.provideFileDecoration(vscode.Uri.file(at('services/search'))), 'unless decorateExplorer is on');
      // Then a change to a repo updates the built-in Explorer's row too.
      let updated = false;
      const sub = decorations.onDidChangeFileDecorations(uris => (updated ||= !!uris?.some(u => u.scheme === 'file' && u.fsPath === at('services/search'))));
      store.refresh(at('services/search'));
      await waitFor('the built-in Explorer row to update', () => updated);
      sub.dispose();
      assert.equal(decorations.provideFileDecoration(vscode.Uri.parse('untitled:x')), undefined);
    } finally {
      await config.update('decorateExplorer', undefined, vscode.ConfigurationTarget.Global);
      rmSync(path.join(repo, 'brand-new'), { recursive: true, force: true });
      store.refresh(repo);
    }
  });

  test('a HEAD document of a file not in HEAD is empty', async () => {
    const provider = new HeadContentProvider();
    const uri = headUri(vscode.Uri.file(at('services/search/none.ts')), at('services/search'), 'none.ts');
    assert.equal(await provider.provideTextDocumentContent(uri), '');
  });

  test('ignored files: rows in many repos are checked a few repos at a time, even when batches overlap', async ({ store }) => {
    await waitFor('the repos', () => store.all().length >= IGNORE_CONCURRENCY * 4);
    const repos = store.all().filter(r => !r.isSubmodule).slice(0, IGNORE_CONCURRENCY * 4);
    let active = 0;
    let peak = 0;
    const asked: string[] = [];
    const provider = new IgnoredDecorationProvider(store, async (root, paths) => {
      asked.push(root);
      peak = Math.max(peak, ++active);
      // Slower than the half second rows are collected for, so the next batch starts meanwhile.
      await new Promise(r => setTimeout(r, 400));
      active--;
      return new Set(paths);
    });
    const ask = (rs: RepoEntry[]) => Promise.all(rs.map(r => provider.provideFileDecoration(toViewUri(path.join(r.root, 'x.log')))));
    try {
      const half = repos.length / 2;
      const first = ask(repos.slice(0, half));
      await waitFor('the first batch to start', () => asked.length > 0);
      const second = ask(repos.slice(half));
      const answers = [...(await first), ...(await second)];
      assert.ok(answers.every(a => a?.color), 'every row answered');
      assert.equal(asked.length, repos.length, 'once per repo');
      assert.equal(peak, IGNORE_CONCURRENCY);

      // Repos still waiting when it's disposed are answered without running git.
      asked.length = 0;
      const pending = ask(repos);
      await waitFor('a batch to start', () => asked.length > 0);
      provider.dispose();
      const after = await pending;
      assert.equal(asked.length, IGNORE_CONCURRENCY, 'only those already running ran git');
      assert.equal(after.filter(Boolean).length, IGNORE_CONCURRENCY, 'the rest answered as not ignored');
    } finally {
      provider.dispose();
    }
  });

  test('ignored files: refreshed on saving .gitignore, left alone when git fails or decorations are off', async ({ store, items, problems, explorer }) => {
    const repo = at('services/notification');
    await waitFor('notification', () => store.get(repo));
    const provider = new IgnoredDecorationProvider(store);
    let fired = 0;
    const sub = provider.onDidChangeFileDecorations(() => fired++);
    try {
      const ignore = await vscode.workspace.openTextDocument(path.join(repo, '.gitignore'));
      const edit = new vscode.WorkspaceEdit();
      edit.insert(ignore.uri, ignore.lineAt(ignore.lineCount - 1).range.end, '\n');
      await vscode.workspace.applyEdit(edit);
      await ignore.save();
      await waitFor('a refresh on save', () => fired > 0);
      const git = vscode.workspace.getConfiguration('git');
      await git.update('path', '/nonexistent/git', vscode.ConfigurationTarget.Global);
      try {
        assert.equal(await provider.provideFileDecoration(toViewUri(path.join(repo, 'debug.log'))), undefined, 'git failed');
      } finally {
        await git.update('path', undefined, vscode.ConfigurationTarget.Global);
      }
      await git.update('decorations.enabled', false, vscode.ConfigurationTarget.Global);
      assert.equal(await provider.provideFileDecoration(toViewUri(path.join(repo, 'debug.log'))), undefined, 'git.decorations.enabled');
      await git.update('decorations.enabled', undefined, vscode.ConfigurationTarget.Global);
      await vscode.workspace.getConfiguration('explorer').update('decorations.colors', false, vscode.ConfigurationTarget.Global);
      assert.equal(await provider.provideFileDecoration(toViewUri(path.join(repo, 'debug.log'))), undefined, 'explorer.decorations.colors');
      await vscode.workspace.getConfiguration('explorer').update('decorations.colors', undefined, vscode.ConfigurationTarget.Global);
      assert.equal(await provider.provideFileDecoration(toViewUri(at('docs/README.md'))), undefined, 'not in a repo');
      const pending = provider.provideFileDecoration(toViewUri(path.join(repo, 'debug.log')));
      provider.dispose();
      assert.equal(await pending, undefined, 'answered when disposed');
    } finally {
      sub.dispose();
      provider.dispose();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }

    // A warning alone is colored as a warning.
    const diagnostics = vscode.languages.createDiagnosticCollection('integration');
    const file = vscode.Uri.file(at('docs/README.md'));
    try {
      diagnostics.set(file, [new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), 'w', vscode.DiagnosticSeverity.Warning)]);
      assert.equal((problems.provideFileDecoration(toViewUri(file.fsPath))?.color as vscode.ThemeColor).id, 'list.warningForeground');
    } finally {
      diagnostics.dispose();
    }

    // The built-in Explorer's own mark of an unknown file type. multiRootSuite.ts checks a workspace folder that can't be read.
    const fifo = at('docs', 'a-fifo');
    execFileSync('mkfifo', [fifo]);
    try {
      await explorer.getChildren({ uri: vscode.Uri.file(at('docs')), isDir: true });
      const unknown = items.provideFileDecoration(toViewUri(fifo));
      assert.deepEqual([unknown?.badge, unknown?.tooltip], ['?', 'Unknown File Type']);
    } finally {
      rmSync(fifo);
    }
  });

  test('workspace helpers: git.path as a list, no workspace folders, and rows picked without a selection', async () => {
    const git = vscode.workspace.getConfiguration('git');
    await git.update('path', ['/opt/git', '/usr/bin/git'], vscode.ConfigurationTarget.Global);
    try {
      assert.equal(gitPath(), '/opt/git', 'the first of a list');
    } finally {
      await git.update('path', undefined, vscode.ConfigurationTarget.Global);
    }
    const restore = stub(vscode.workspace, 'workspaceFolders', undefined);
    try {
      assert.deepEqual(localFolders(), []);
    } finally {
      restore();
    }
    assert.deepEqual(pickRows(undefined, undefined, String), []);
    assert.deepEqual(pickRows('a', undefined, String), ['a']);
  });
}
