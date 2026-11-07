// Integration tests of the path and open commands' less common paths: web
// links in every situation, opening from the keyboard, the workspace folder
// row, and commands left with no rows to act on.
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import type { RepoEntry } from '../store';
import type { ExplorerNode } from '../views/repoExplorer';
import { at, sample, stub, test, waitFor } from './harness';

/** Records the given VS Code commands instead of running them. */
function intercept(ids: string[]) {
  const ran: unknown[][] = [];
  const execute = vscode.commands.executeCommand;
  const restore = stub(vscode.commands, 'executeCommand', ((id: string, ...args: unknown[]) => {
    if (!ids.includes(id)) return execute(id, ...args);
    ran.push([id, ...args]);
    return Promise.resolve();
  }) as never);
  return { ran, restore };
}

const row = (rel: string, isDir = false): ExplorerNode => ({ uri: vscode.Uri.file(at(rel)), isDir });

export function registerPathCommandTests(): void {
  test('Open on Remote and Copy Remote URL: web links, notes, and repos it can\'t link', async ({ store }) => {
    const repo = 'services/notification';
    const git = (...args: string[]) => execFileSync('git', args, { cwd: at(repo) }).toString().trim();
    await waitFor('the repos', () => store.get(at(repo))?.status && store.get(at('services/search')));
    const original = git('remote', 'get-url', 'origin');
    git('remote', 'set-head', 'origin', 'main');
    git('remote', 'set-url', 'origin', 'https://github.com/acme/notification.git');
    git('switch', '-q', '-c', 'never-pushed');
    store.refresh(at(repo));
    await waitFor('the new branch', () => store.get(at(repo))?.status?.branch.head === 'never-pushed');
    const opened: string[] = [];
    const info: string[] = [];
    const restore = [
      stub(vscode.env, 'openExternal', (async (uri: vscode.Uri) => opened.push(uri.toString(true)) > 0) as never),
      stub(vscode.window, 'showInformationMessage', (async (text: string) => void info.push(text)) as never),
    ];
    try {
      await vscode.commands.executeCommand('multiGitExplorer.openOnRemote', row(`${repo}/keep.log`), [row(`${repo}/keep.log`), row(`${repo}/dist`, true), row('docs/README.md'), row('services/search/README.md')]);
      assert.deepEqual(opened, ['https://github.com/acme/notification/blob/main/keep.log', 'https://github.com/acme/notification/tree/main/dist']);
      assert.deepEqual(info, [
        "never-pushed isn't pushed, so the link points to main. README.md is not in a git repository. search has no remote on a website that a link can be made for.",
      ]);

      // Before its status is known, the branch comes from .git; a detached HEAD links its commit.
      const fake = (entry: Partial<RepoEntry>) => stub(store, 'repoContaining', (() => ({ root: at(repo), name: 'notification', ...entry })) as never);
      for (const [entry, expected] of [
        [{ cheap: { branch: 'main', hasRemote: true } }, /\/blob\/main\/keep\.log$/],
        [{ cheap: { detachedOid: 'abc1234', hasRemote: true } }, /\/blob\/abc1234\/keep\.log$/],
        [{ status: { branch: { detached: true, oid: 'def5678' } } }, /\/blob\/def5678\/keep\.log$/],
        [{}, /\/blob\/[0-9a-f]{40}\/keep\.log$/],
      ] as const) {
        opened.length = 0;
        const restoreRepo = fake(entry as Partial<RepoEntry>);
        try {
          await vscode.commands.executeCommand('multiGitExplorer.openOnRemote', row(`${repo}/keep.log`));
        } finally {
          restoreRepo();
        }
        assert.match(opened[0], expected);
      }
    } finally {
      restore.forEach(r => r());
      git('switch', '-q', 'main');
      git('branch', '-q', '-D', 'never-pushed');
      git('remote', 'set-head', 'origin', '-d');
      git('remote', 'set-url', 'origin', original);
      store.refresh(at(repo));
    }
  });

  test('Space and Enter from the keyboard open files, changes, and folders as a tree does', async ({ explorer }) => {
    const changed: ExplorerNode = { ...row('services/api-gateway/README.md'), change: { path: 'README.md', letter: 'M', staged: false, unstaged: true } };
    const { ran, restore } = intercept(['list.toggleExpand', 'list.select', 'vscode.open', 'multiGitExplorer.openChange']);
    let focused: ExplorerNode | undefined;
    const focus = stub(explorer, 'focusedRow', async () => focused);
    const rows = stub(explorer, 'keyboardRows', async (n?: ExplorerNode) => [n!]);
    try {
      for (focused of [undefined, row('docs', true), row('docs/README.md'), changed]) {
        await vscode.commands.executeCommand('multiGitExplorer.openPreserveFocus');
        await vscode.commands.executeCommand('multiGitExplorer.openAndPassFocus');
      }
    } finally {
      rows();
      focus();
      restore();
    }
    assert.deepEqual(
      ran.map(r => r[0]),
      ['list.toggleExpand', 'list.select', 'list.toggleExpand', 'list.select', 'vscode.open', 'vscode.open', 'multiGitExplorer.openChange', 'multiGitExplorer.openChange'],
    );
    assert.deepEqual(ran[4][2], { preserveFocus: true });
    assert.deepEqual(ran[5][2], { preserveFocus: false, preview: false });
  });

  test('Open With, Remove Folder from Workspace, Compare Selected, and paths of the workspace folder', async ({ explorer }) => {
    const { ran, restore } = intercept(['explorer.openWith', 'vscode.diff', 'workbench.action.findInFiles']);
    const updates: unknown[][] = [];
    const update = stub(vscode.workspace, 'updateWorkspaceFolders', ((...args: unknown[]) => updates.push(args) > 0) as never);
    const clipboard = await vscode.env.clipboard.readText();
    const root: ExplorerNode = { uri: vscode.Uri.file(sample), isDir: true };
    try {
      await vscode.commands.executeCommand('multiGitExplorer.openWith', row('docs/README.md'), [row('docs', true), row('docs/README.md')]);
      await vscode.commands.executeCommand('multiGitExplorer.removeRootFolder', root);
      await vscode.commands.executeCommand('multiGitExplorer.compareSelected', row('docs/README.md'), [row('services/search/README.md'), row('services/api-gateway/README.md')]);
      await vscode.commands.executeCommand('multiGitExplorer.compareSelected', row('services/search/README.md'), [row('services/search/README.md'), row('services/api-gateway/README.md')]);
      await vscode.commands.executeCommand('multiGitExplorer.findInFolder', root);
      await vscode.commands.executeCommand('multiGitExplorer.copyRelativePath', root);
      assert.equal(await vscode.env.clipboard.readText(), path.basename(sample), 'a workspace folder is given by name');
      const deleted: ExplorerNode = { ...row('docs/gone.txt'), change: { path: 'gone.txt', letter: 'D', staged: false, unstaged: true } };
      assert.equal(await vscode.commands.executeCommand('multiGitExplorer.openToSide', deleted), undefined, 'no file to open');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      assert.equal(await vscode.commands.executeCommand('multiGitExplorer.revealInFiles'), undefined, 'no editor open');
      const reveal = stub(explorer, 'reveal', async () => undefined);
      try {
        await vscode.commands.executeCommand('multiGitExplorer.revealInFiles', vscode.Uri.file(at('docs')));
        await vscode.commands.executeCommand('multiGitExplorer.revealInFiles', vscode.Uri.file(at('docs', 'missing.txt')));
      } finally {
        reveal();
      }
    } finally {
      update();
      restore();
      await vscode.env.clipboard.writeText(clipboard);
    }
    assert.deepEqual(ran.map(r => r[0]), ['explorer.openWith', 'vscode.diff', 'workbench.action.findInFiles']);
    assert.equal((ran[1][3] as string), 'README.md ↔ README.md', 'only when the clicked file is one of two selected');
    assert.deepEqual(ran[2][1], { filesToInclude: sample, triggerSearch: true });
    assert.deepEqual(updates, [[0, 1]], 'the workspace without that folder');
  });
}
