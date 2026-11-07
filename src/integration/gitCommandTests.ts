// Integration tests of the git commands on repo rows: finding the repo, fetch,
// pull and push, Switch Branch, View All Changes, and the filters. They change
// the sample repos (switching branches and pushing), so they run last.
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Priority } from '../core/queue';
import type { RepoStore } from '../store';
import type { ExplorerNode } from '../views/repoExplorer';
import type { ReposNode } from '../views/reposView';
import { at, stub, test, waitFor } from './harness';

const git = (rel: string, ...args: string[]) => execFileSync('git', args, { cwd: at(rel), encoding: 'utf8' }).trim();
const run = (command: string, ...args: unknown[]) => vscode.commands.executeCommand(command, ...args);

type Answer = string | (() => string);
type Shown = { kind: string; text: string; buttons: string[] };

/** Messages shown while `fn` runs, answering each kind with the given button. */
async function messages(answers: { warning?: Answer; error?: Answer; info?: Answer }, fn: () => PromiseLike<unknown>): Promise<Shown[]> {
  const shown: Shown[] = [];
  const answer = (kind: 'warning' | 'error' | 'info') => (async (text: string, ...rest: unknown[]) => {
    const buttons = rest.filter((r): r is string => typeof r === 'string');
    shown.push({ kind, text, buttons });
    const given = answers[kind];
    const button = typeof given === 'function' ? given() : given;
    return button && buttons.includes(button) ? button : undefined;
  }) as never;
  const restore = [
    stub(vscode.window, 'showWarningMessage', answer('warning')),
    stub(vscode.window, 'showErrorMessage', answer('error')),
    stub(vscode.window, 'showInformationMessage', answer('info')),
  ];
  try {
    await fn();
    // Let follow-up dialogs, such as Show Details, open.
    await new Promise(r => setTimeout(r, 50));
  } finally {
    restore.forEach(r => r());
  }
  return shown;
}

/** Intercepts one VS Code command while `fn` runs, recording its arguments. */
async function intercept(id: string, fn: () => PromiseLike<unknown>): Promise<unknown[][]> {
  const calls: unknown[][] = [];
  const execute = vscode.commands.executeCommand;
  const restore = stub(vscode.commands, 'executeCommand', ((command: string, ...args: unknown[]) => {
    if (command !== id) return execute(command, ...args);
    calls.push(args);
    return Promise.resolve();
  }) as typeof vscode.commands.executeCommand);
  try {
    await fn();
  } finally {
    restore();
  }
  return calls;
}

/** Runs `fn` with `git.path` pointing nowhere, so every git command fails. */
async function withBrokenGit(fn: () => PromiseLike<unknown>): Promise<void> {
  const config = vscode.workspace.getConfiguration('git');
  await config.update('path', '/nonexistent/git', vscode.ConfigurationTarget.Global);
  try {
    await fn();
  } finally {
    await config.update('path', undefined, vscode.ConfigurationTarget.Global);
  }
}

async function settled(store: RepoStore, rel: string, check: (head: string | undefined) => boolean): Promise<void> {
  store.refresh(at(rel), Priority.User);
  await waitFor(`${rel} to update`, () => check(store.get(at(rel))?.status?.branch.head));
}

export function registerGitCommandTests(): void {
  test('repo commands find their repo from a URI, a file tree row, a Git Repositories row, or the active file', async ({ store }) => {
    const clipboard = await vscode.env.clipboard.readText();
    const copied = async (arg: unknown) => {
      await run('multiGitExplorer.copyBranch', arg);
      return vscode.env.clipboard.readText();
    };
    try {
      assert.equal(await copied(vscode.Uri.file(at('services/api-gateway'))), 'main');
      const row: ExplorerNode = { uri: vscode.Uri.file(at('services/auth-service/src')), isDir: true };
      assert.equal(await copied(row), 'feat/sso', 'a folder inside a repo');
      const reposRow: ReposNode = { type: 'repo', root: at('services/mobile-api') };
      assert.equal(await copied(reposRow), 'fix/login');
      await waitFor('design-system status', () => store.get(at('frontend/design-system'))?.status);
      assert.match(await copied(vscode.Uri.file(at('frontend/design-system'))), /^[0-9a-f]{7,}$/, 'a detached HEAD copies its commit');
      await vscode.window.showTextDocument(vscode.Uri.file(at('services/notification/keep.log')));
      assert.equal(await copied(undefined), 'main', 'the active file\'s repo');
      const shown = await messages({}, () => run('multiGitExplorer.copyBranch', vscode.Uri.file(at('docs'))));
      assert.deepEqual(shown.map(m => m.text), ['Multi-Git Explorer: this folder is not a git repository.']);
      const group: ReposNode = { type: 'group', key: 'clean' };
      assert.equal((await messages({}, () => run('multiGitExplorer.copyBranch', group))).length, 0, 'a group row means the active file');
    } finally {
      await vscode.env.clipboard.writeText(clipboard);
      await run('workbench.action.closeAllEditors');
    }
  });

  test('Open Terminal, Open in New Window, Scan This Folder and Refresh', async ({ store }) => {
    await run('multiGitExplorer.openTerminal', vscode.Uri.file(at('services/search')));
    const terminal = vscode.window.terminals.find(t => t.name === 'search');
    assert.ok(terminal, 'a terminal named after the repo');
    terminal.dispose();

    const opened = await intercept('vscode.openFolder', () => run('multiGitExplorer.openInNewWindow', vscode.Uri.file(at('services/search'))));
    assert.equal((opened[0][0] as vscode.Uri).fsPath, at('services/search'));
    assert.deepEqual(opened[0][1], { forceNewWindow: true });

    const deep = at('archive', '2023', 'q1', 'old-crm');
    await run('multiGitExplorer.scanFolder', { uri: vscode.Uri.file(path.dirname(deep)), isDir: true });
    await run('multiGitExplorer.scanFolder', vscode.Uri.file(path.dirname(deep)));
    assert.equal(await run('multiGitExplorer.scanFolder', { type: 'repo', root: deep }), undefined, 'a Git Repositories row has nothing to scan');
    assert.equal(await run('multiGitExplorer.scanFolder'), undefined);

    // Refresh finds the repos again; the one found by scanning past the depth limit stays.
    const before = store.all().length;
    await run('multiGitExplorer.refresh');
    assert.equal(store.all().length, before);
  });

  test('the Git Repositories filter and the file tree filter picker', async ({ explorer, reposView }) => {
    let restore = stub(vscode.window, 'showInputBox', (async () => 'auth') as typeof vscode.window.showInputBox);
    await run('multiGitExplorer.filter');
    restore();
    assert.equal(reposView.filter, 'auth');
    restore = stub(vscode.window, 'showInputBox', (async () => undefined) as typeof vscode.window.showInputBox);
    await run('multiGitExplorer.filter');
    restore();
    assert.equal(reposView.filter, 'auth', 'cancelling keeps the filter');
    await run('multiGitExplorer.clearFilter');
    assert.equal(reposView.filter, '');

    type Item = vscode.QuickPickItem & { filter: string };
    let offered: Item[] = [];
    const pick = (answer: (items: Item[]) => Item[] | undefined) =>
      stub(vscode.window, 'showQuickPick', (async (items: Item[]) => {
        offered = items;
        return answer(items);
      }) as never);
    try {
      restore = pick(items => items.filter(i => i.filter === 'unpushed'));
      await run('multiGitExplorer.filterExplorer');
      restore();
      assert.deepEqual(offered.filter(i => i.picked).map(i => i.filter), ['changes'], 'Changed files is offered first');
      assert.deepEqual(explorer.activeFilters, ['unpushed']);
      restore = pick(() => undefined);
      await run('multiGitExplorer.filterExplorer');
      restore();
      assert.deepEqual(offered.filter(i => i.picked).map(i => i.filter), ['unpushed'], 'the filters on are picked');
      assert.deepEqual(explorer.activeFilters, ['unpushed'], 'cancelling keeps them');
    } finally {
      explorer.setFilters([]);
    }
  });

  test('View All Changes opens every change in one editor, or says why it can\'t', async () => {
    const api = at('services/api-gateway');
    const gone = path.join(api, 'README.md');
    const readmeText = readFileSync(gone);
    rmSync(gone);
    try {
      const calls = await intercept('vscode.changes', () => run('multiGitExplorer.openChanges', vscode.Uri.file(api)));
      const [title, resources] = calls[0] as [string, [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined][]];
      assert.equal(title, 'Changes: api-gateway');
      const readme = resources.find(r => r[0].fsPath === gone)!;
      assert.ok(readme[1] && !readme[2], 'a deleted file has only its old side');
      const added = resources.find(r => r[1] === undefined)!;
      assert.ok(added[2], 'a new file has only its new side');
      const unique = new Set(resources.map(r => r[0].toString()));
      assert.equal(unique.size, resources.length, 'each file once, even when staged and changed');
    } finally {
      writeFileSync(gone, readmeText);
    }

    let shown: Shown[] = await messages({}, () => run('multiGitExplorer.openChanges', vscode.Uri.file(at('frontend/web-app'))));
    assert.deepEqual(shown.map(m => m.text), ['web-app has no changes.']);

    for (const fake of [undefined, { isActive: false, activate: async () => undefined }, { isActive: true, exports: { getAPI: () => ({ getRepository: () => null, openRepository: async () => null }) } }]) {
      const restore = stub(vscode.extensions, 'getExtension', (() => fake) as never);
      try {
        shown = await messages({}, () => run('multiGitExplorer.openChanges', vscode.Uri.file(api)));
      } finally {
        restore();
      }
      assert.deepEqual(shown.map(m => m.text), ["Multi-Git Explorer: couldn't open api-gateway in VS Code's Git."]);
    }
    const scm = await intercept('workbench.view.scm', () => run('multiGitExplorer.openInScm', vscode.Uri.file(api)));
    assert.equal(scm.length, 1);
  });

  test('Fetch, Pull and Push run git with progress, and show git\'s error when it fails', async ({ store }) => {
    let shown: Shown[] = await messages({}, () => run('multiGitExplorer.fetch', vscode.Uri.file(at('services/notification'))));
    assert.equal(shown.length, 0, 'fetching from a reachable remote');

    shown = await messages({ error: 'Show Details' }, () => run('multiGitExplorer.pull', vscode.Uri.file(at('frontend/local-sandbox'))));
    assert.match(shown[0].text, /^Pulling local-sandbox failed: /);
    assert.deepEqual(shown[0].buttons, ['Show Details']);
    assert.ok(shown[1]?.text, 'Show Details shows git\'s output');

    await waitFor('local-sandbox status', () => store.get(at('frontend/local-sandbox'))?.status);
    shown = await messages({}, () => run('multiGitExplorer.push', vscode.Uri.file(at('frontend/local-sandbox'))));
    assert.deepEqual(shown.map(m => m.text), ['local-sandbox has no remote to push to.']);
    await waitFor('mobile-api status', () => store.get(at('services/mobile-api'))?.status);
    await withBrokenGit(async () => {
      shown = await messages({}, () => run('multiGitExplorer.push', vscode.Uri.file(at('services/mobile-api'))));
    });
    assert.deepEqual(shown.map(m => m.text), ['mobile-api has no remote to push to.'], 'remotes can\'t be listed');

    shown = await messages({}, () => run('multiGitExplorer.push', vscode.Uri.file(at('services/mobile-api'))));
    assert.equal(shown.length, 0);
    assert.equal(git('services/mobile-api', 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/fix/login', 'a first push sets the upstream');
    shown = await messages({}, () => run('multiGitExplorer.push', vscode.Uri.file(at('services/auth-service'))));
    assert.equal(shown.length, 0);
    assert.equal(git('services/auth-service', 'rev-list', '--count', '@{upstream}..HEAD'), '0', 'pushed');
  });

  test('Fetch All fetches every repo with a remote, and lists the ones that failed', async ({ store }) => {
    let shown: Shown[] = await messages({}, () => run('multiGitExplorer.fetchAll'));
    assert.equal(shown.length, 0);
    await withBrokenGit(async () => {
      shown = await messages({}, () => run('multiGitExplorer.fetchAll'));
    });
    assert.match(shown[0].text, /^Couldn't fetch \d+ repos: [^,]+, [^,]+, [^,]+, [^,]+, [^,]+, and \d+ more$/);

    const one = store.get(at('services/search'))!;
    let restore = stub(store, 'all', () => [one]);
    try {
      await withBrokenGit(async () => {
        shown = await messages({}, () => run('multiGitExplorer.fetchAll'));
      });
      assert.deepEqual(shown.map(m => m.text), ["Couldn't fetch 1 repo: search"]);
      const progress = vscode.window.withProgress;
      const cancelled = stub(vscode.window, 'withProgress', ((options, task) =>
        progress(options, (p, token) => task(p, { ...token, isCancellationRequested: true }))) as typeof vscode.window.withProgress);
      try {
        await withBrokenGit(async () => {
          shown = await messages({}, () => run('multiGitExplorer.fetchAll'));
        });
      } finally {
        cancelled();
      }
      assert.equal(shown.length, 0, 'nothing is fetched once cancelled');
    } finally {
      restore();
    }
    restore = stub(store, 'all', () => []);
    try {
      shown = await messages({}, () => run('multiGitExplorer.fetchAll'));
    } finally {
      restore();
    }
    assert.deepEqual(shown.map(m => m.text), ['Multi-Git Explorer: no repos with a remote to fetch.']);
  });

  test('Switch Branch creates, picks and stashes like Source Control does', async ({ store }) => {
    const repo = 'services/notification';
    const uri = vscode.Uri.file(at(repo));
    type Item = vscode.QuickPickItem & { action?: object };
    let pickerItems: Item[][] = [];
    let inputOptions: vscode.InputBoxOptions | undefined;
    /** Switch Branch with its pickers answered in turn, and the name typed. */
    const switchWith = async (picks: ((items: Item[]) => Item | undefined)[], name?: string, answers: { warning?: Answer } = {}) => {
      pickerItems = [];
      const restore = [
        stub(vscode.window, 'showQuickPick', (async (items: Item[]) => {
          pickerItems.push(items);
          return picks.shift()?.(items);
        }) as never),
        stub(vscode.window, 'showInputBox', (async (options: vscode.InputBoxOptions) => {
          inputOptions = options;
          return name;
        }) as never),
      ];
      try {
        return await messages(answers, () => run('multiGitExplorer.switchBranch', uri));
      } finally {
        restore.forEach(r => r());
      }
    };
    const labelled = (text: string) => (items: Item[]) => items.find(i => i.label.endsWith(` ${text}`) || i.label === text);

    let shown: Shown[] = await messages({}, () => run('multiGitExplorer.switchBranch', vscode.Uri.file(at('services/billing'))));
    assert.deepEqual(shown.map(m => m.text), ['Finish or abort the merge in billing before switching branches.']);
    await withBrokenGit(async () => {
      shown = await messages({}, () => run('multiGitExplorer.switchBranch', uri));
    });
    assert.match(shown[0].text, /^Couldn't list branches of notification: /);

    // A branch whose upstream was deleted, and a remote branch never checked out.
    git(repo, 'branch', 'old-topic');
    git(repo, 'push', '-q', '-u', 'origin', 'old-topic');
    git(repo, 'push', '-q', 'origin', '--delete', 'old-topic');
    git(repo, 'push', '-q', 'origin', 'HEAD:refs/heads/remote-only');
    git(repo, 'fetch', '-q', '--prune');

    await switchWith([() => undefined]);
    const labels = pickerItems[0].map(i => `${i.label} ${i.description ?? ''}`);
    assert.ok(labels.some(l => /^\$\(check\) main current/.test(l)), labels.join('\n'));
    assert.ok(labels.some(l => /old-topic upstream deleted/.test(l)));
    assert.ok(labels.some(l => /^\$\(cloud\) origin\/remote-only not checked out/.test(l)));
    await switchWith([labelled('main')]);
    assert.equal(git(repo, 'branch', '--show-current'), 'main', 'picking the current branch does nothing');

    await switchWith([labelled('Create new branch…')], '  ');
    assert.equal(git(repo, 'branch', '--show-current'), 'main', 'an empty name does nothing');
    const validate = inputOptions!.validateInput!;
    assert.equal(await validate(''), undefined);
    assert.equal(await validate('bad..name'), 'Not a valid branch name');
    assert.equal(await validate('main'), 'A branch with this name already exists');
    assert.equal(await validate('feat/new'), undefined);
    await switchWith([labelled('Create new branch…')], 'feat/new');
    await settled(store, repo, head => head === 'feat/new');

    await switchWith([labelled('Create new branch from…'), () => undefined]);
    assert.equal(git(repo, 'branch', '--show-current'), 'feat/new', 'no starting point picked');
    await switchWith([labelled('Create new branch from…'), items => items.find(i => i.label === 'main')], 'feat/from-main');
    assert.equal(inputOptions?.title, 'New branch in notification from main');
    await settled(store, repo, head => head === 'feat/from-main');

    // Changes that switching would overwrite: cancel, stash and switch, and a stash that fails.
    writeFileSync(at(repo, 'keep.log'), 'committed on feat/from-main\n');
    git(repo, 'commit', '-q', '-am', 'change keep.log');
    writeFileSync(at(repo, 'keep.log'), 'not committed\n');
    shown = await switchWith([labelled('main')], undefined, {});
    assert.match(shown[0].text, /would be overwritten by switching to main/);
    assert.equal(git(repo, 'branch', '--show-current'), 'feat/from-main', 'cancelled');
    const lock = at(repo, '.git', 'index.lock');
    const lockThenStash = () => {
      writeFileSync(lock, '');
      return 'Stash and Switch';
    };
    try {
      shown = await switchWith([labelled('main')], undefined, { warning: lockThenStash });
    } finally {
      rmSync(lock, { force: true });
    }
    assert.match(shown[1].text, /^Couldn't switch notification to main: /, 'the stash failed');
    shown = await switchWith([labelled('main')], undefined, { warning: 'Stash and Switch' });
    assert.deepEqual(shown.map(m => m.text).slice(1), ['Stashed your changes in notification and switched to main.']);
    assert.equal(git(repo, 'branch', '--show-current'), 'main');
    assert.ok(git(repo, 'stash', 'list').includes('Before switching to main'));

    shown = await switchWith([() => ({ label: 'origin/main', action: { remote: 'origin/main' } })]);
    assert.match(shown[0].text, /^Couldn't switch notification to origin\/main: /, 'a branch named main exists already');
    assert.deepEqual(shown[0].buttons, [], 'not from git itself, so no details');

    const sandbox = await (async () => {
      const restore = stub(vscode.window, 'showQuickPick', (async (items: Item[]) => {
        pickerItems = [items];
        return undefined;
      }) as never);
      try {
        await run('multiGitExplorer.switchBranch', vscode.Uri.file(at('frontend/local-sandbox')));
      } finally {
        restore();
      }
      return pickerItems[0];
    })();
    assert.ok(!sandbox.some(i => i.label === 'remote branches'), 'no remote branches, no heading for them');
    const restoreSearch = stub(vscode.window, 'showQuickPick', (async (items: Item[]) => void (pickerItems = [items])) as never);
    try {
      await run('multiGitExplorer.switchBranch', vscode.Uri.file(at('services/search')));
    } finally {
      restoreSearch();
    }
    assert.ok(pickerItems[0].some(i => /↓4 behind origin\/main/.test(i.description ?? '')), 'how far behind its upstream');
    assert.ok(existsSync(at(repo)));
  });
}
