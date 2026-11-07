// Integration tests of the file tree's less common paths in a one-folder
// workspace: a provider with no view, filtering with deleted files and new
// folders, nested files opened and closed, compact rows that break apart, and
// .gitignore files that change. multiRootSuite.ts covers several folders.
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { RepoExplorerProvider, type ExplorerNode } from '../views/repoExplorer';
import { at, sample, stub, test, waitFor, withScratch } from './harness';

const names = (nodes: readonly ExplorerNode[]) => nodes.map(n => path.basename(n.uri.fsPath)).sort();

/** Sets explorer settings for the length of `fn`. */
async function withExplorerSettings(settings: Record<string, unknown>, fn: () => Promise<void>): Promise<void> {
  const config = vscode.workspace.getConfiguration('explorer');
  for (const [key, value] of Object.entries(settings)) await config.update(key, value, vscode.ConfigurationTarget.Global);
  try {
    await fn();
  } finally {
    for (const key of Object.keys(settings)) await config.update(key, undefined, vscode.ConfigurationTarget.Global);
  }
}

export function registerExplorerTests(): void {
  test('a file tree with no view: nothing focused or revealed, and folders outside the workspace listed as they are', async ({ store }) => {
    const memento = { get: (_: string, d: unknown) => d, update: async () => undefined, keys: () => [] } as unknown as vscode.Memento;
    const provider = new RepoExplorerProvider(store, memento);
    const outside = mkdtempSync(path.join(tmpdir(), 'multi-git-explorer-outside-'));
    try {
      writeFileSync(path.join(outside, 'x.txt'), '');
      assert.equal(await provider.focusedRow(), undefined);
      assert.deepEqual(await provider.keyboardRows(), []);
      await provider.reveal(vscode.Uri.file(at('docs')), true);
      assert.equal(provider.selectedFolder()?.fsPath, sample, 'the workspace folder');
      provider.setFilters(['changes']);
      provider.setFilters([]);
      assert.deepEqual(await provider.getChildren({ uri: vscode.Uri.file(at('docs/README.md')), isDir: false }), [], 'a file without nested files');
      assert.deepEqual(names(await provider.getChildren({ uri: vscode.Uri.file(outside), isDir: true })), ['x.txt']);
    } finally {
      provider.dispose();
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('filtering: deleted files, untracked folders opened, sorted by date, and updates as repos change', ({ store, explorer }) =>
    withExplorerSettings({ sortOrder: 'modified', excludeGitIgnore: true, 'fileNesting.enabled': true }, async () => {
      const repo = at('frontend/web-app');
      const fresh = path.join(repo, 'fresh');
      rmSync(path.join(repo, 'README.md'));
      mkdirSync(path.join(fresh, 'node_modules'), { recursive: true });
      mkdirSync(path.join(fresh, 'inner'), { recursive: true });
      writeFileSync(path.join(fresh, 'a.ts'), '');
      writeFileSync(path.join(repo, '.gitignore'), 'skip.ts\n');
      const tree = (explorer as unknown as { treeView: vscode.TreeView<ExplorerNode> }).treeView;
      try {
        store.refresh(repo);
        await waitFor('web-app changes', () => store.get(repo)?.changes?.has('fresh/') && store.get(repo)?.changes?.has('README.md'));
        explorer.setFilters(['changes']);
        const repoRow = (await explorer.getChildren((await explorer.getChildren(undefined)).find(n => n.uri.fsPath === at('frontend'))!)).find(n => n.uri.fsPath === repo)!;
        const rows = await explorer.getChildren(repoRow);
        const readme = rows.find(n => path.basename(n.uri.fsPath) === 'README.md')!;
        assert.equal(explorer.getTreeItem(readme).contextValue, 'file change deleted hosted');
        const folder = rows.find(n => n.uri.fsPath === fresh)!;
        assert.equal(explorer.getTreeItem(folder).description, 'untracked');
        assert.deepEqual(names(await explorer.getChildren(folder)), ['a.ts', 'inner'], 'all of it, without excluded folders');
        assert.ok((await explorer.getChildren(folder)).every(n => n.change?.letter === 'U'));

        // A repo that changes rebuilds the tree a moment later; a folder that changes doesn't need to.
        store.refresh(repo);
        writeFileSync(at('docs', 'while-filtering.txt'), '');
        rmSync(at('docs', 'while-filtering.txt'));
        const restore = stub(explorer as unknown as { matchingRepos(): unknown[] }, 'matchingRepos', () => []);
        try {
          explorer.setFilters(['changes']);
          assert.equal(tree.message, 'No repos match the filter (changed files).');
        } finally {
          restore();
        }
      } finally {
        explorer.setFilters([]);
        execFileSync('git', ['checkout', '--', 'README.md'], { cwd: repo });
        rmSync(fresh, { recursive: true, force: true });
        rmSync(path.join(repo, '.gitignore'), { force: true });
        store.refresh(repo);
      }
    }));

  test('nest parents start closed with fileNesting.expand off, and remember being opened', ({ explorer }) =>
    withScratch(dir =>
      withExplorerSettings({ 'fileNesting.enabled': true, 'fileNesting.expand': false }, async () => {
        writeFileSync(path.join(dir, 'app.ts'), '');
        writeFileSync(path.join(dir, 'app.js'), '');
        const tree = (explorer as unknown as { treeView: vscode.TreeView<ExplorerNode> }).treeView;
        await vscode.commands.executeCommand('workbench.view.extension.multiGitExplorer');
        await explorer.reveal(vscode.Uri.file(dir), true);
        const parent = (await explorer.getChildren({ uri: vscode.Uri.file(dir), isDir: true })).find(n => path.basename(n.uri.fsPath) === 'app.ts')!;
        assert.equal(explorer.getTreeItem(parent).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
        await tree.reveal(parent, { expand: true });
        await waitFor('the nest to open', () => explorer.getTreeItem(parent).collapsibleState === vscode.TreeItemCollapsibleState.Expanded);
        await vscode.commands.executeCommand('workbench.actions.treeView.multiGitExplorer.explorer.collapseAll');
        await waitFor('the nest to close', () => explorer.getTreeItem(parent).collapsibleState === vscode.TreeItemCollapsibleState.Collapsed);
      }),
    ));

  test('compact rows break apart when a folder gets a second entry, or goes away', ({ explorer }) =>
    withScratch(dir =>
      withExplorerSettings({ compactFolders: true }, async () => {
        mkdirSync(path.join(dir, 'one', 'two', 'three'), { recursive: true });
        const scratch = { uri: vscode.Uri.file(dir), isDir: true };
        const row = () => explorer.getChildren(scratch).then(rows => rows.find(n => n.compact?.[0].fsPath === path.join(dir, 'one') || n.uri.fsPath === path.join(dir, 'one'))!);
        let one = await row();
        await explorer.getChildren(one);
        assert.equal(one.compact?.length, 3, 'one/two/three');
        mkdirSync(path.join(dir, 'one', 'other'));
        one = await row();
        await explorer.getChildren(one);
        assert.equal(one.compact, undefined, 'one has two folders now');
        rmSync(path.join(dir, 'one'), { recursive: true });
        assert.deepEqual(await explorer.getChildren(one), [], 'gone');

        // A change at the top of the workspace refreshes the whole tree.
        writeFileSync(at('top-level.txt'), '');
        rmSync(at('top-level.txt'));
      }),
    ));

  test('.gitignore files are read again when they change, appear or go away, nearest first', ({ explorer }) =>
    withScratch(dir =>
      withExplorerSettings({ excludeGitIgnore: true }, async () => {
        const list = async (rel = '.') => names(await explorer.getChildren({ uri: vscode.Uri.file(path.join(dir, rel)), isDir: true }));
        writeFileSync(path.join(dir, '.gitignore'), 'hidden.txt\n');
        writeFileSync(path.join(dir, 'hidden.txt'), '');
        writeFileSync(path.join(dir, 'sub', 'kept.txt'), '');
        writeFileSync(path.join(dir, 'sub', 'hidden.txt'), '');
        await waitForList(list, '.', l => !l.includes('hidden.txt'));
        assert.ok(!(await list()).includes('hidden.txt'), 'read once, then kept');

        writeFileSync(path.join(dir, '.gitignore'), 'kept.txt\n');
        await waitForList(list, '.', l => l.includes('hidden.txt'));
        writeFileSync(path.join(dir, 'sub', '.gitignore'), '!kept.txt\n');
        await waitForList(list, 'sub', l => l.includes('kept.txt'));
        rmSync(path.join(dir, 'sub', '.gitignore'));
        await waitForList(list, 'sub', l => !l.includes('kept.txt'));

        // One that can't be read is skipped, so the one above counts; one in a folder the tree hasn't listed is left for later.
        writeFileSync(path.join(dir, 'sub', '.gitignore'), '!kept.txt\n');
        chmodSync(path.join(dir, 'sub', '.gitignore'), 0o000);
        try {
          await waitForList(list, 'sub', l => l.join() === '.gitignore,hidden.txt');
        } finally {
          chmodSync(path.join(dir, 'sub', '.gitignore'), 0o644);
        }
        mkdirSync(path.join(dir, 'unlisted'));
        writeFileSync(path.join(dir, 'unlisted', '.gitignore'), 'a\n');
        await new Promise(r => setTimeout(r, 300));
        writeFileSync(path.join(dir, 'unlisted', '.gitignore'), 'b\n');
        await new Promise(r => setTimeout(r, 300));
      }),
    ));

  test('revealing a workspace folder itself, or a file outside the workspace, does nothing', async ({ explorer }) => {
    await explorer.reveal(vscode.Uri.file(sample), true);
    const outside = path.join(tmpdir(), 'outside.txt');
    writeFileSync(outside, '');
    try {
      // From an editor tab of a file opened from elsewhere; this once walked up the disk forever.
      await vscode.commands.executeCommand('multiGitExplorer.revealInFiles', vscode.Uri.file(outside));
      await explorer.reveal(vscode.Uri.file(outside), false);
      assert.equal(explorer.getParent({ uri: vscode.Uri.file(outside), isDir: false }), undefined);
    } finally {
      rmSync(outside, { force: true });
    }
  });
}

async function waitForList(list: (rel?: string) => Promise<string[]>, rel: string, check: (names: string[]) => boolean): Promise<void> {
  const started = Date.now();
  while (!check(await list(rel))) {
    if (Date.now() - started > 10_000) throw new Error(`Timed out waiting for ${rel}: ${(await list(rel)).join(', ')}`);
    await new Promise(r => setTimeout(r, 100));
  }
}
