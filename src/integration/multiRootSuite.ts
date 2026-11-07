// Runs in a workspace of several folders, one inside another: the sample's
// services, frontend, and services/search, and a folder that doesn't exist.
// run.ts makes it with --multi-root.
import assert from 'node:assert/strict';
import * as path from 'path';
import * as vscode from 'vscode';
import { RepoExplorerProvider, type ExplorerNode } from '../views/repoExplorer';
import { toViewUri } from '../views/viewUri';
import { at, runAll, stub, test, waitFor } from './harness';

const roots = ['services', 'frontend', 'services/search', 'missing'].map(rel => at(rel));
const row = (rel: string, isDir = false): ExplorerNode => ({ uri: vscode.Uri.file(at(rel)), isDir });

test('each workspace folder is a top-level row, and filtering keeps those with matching repos', async ({ store, explorer }) => {
  await waitFor('discovery', () => store.get(at('services/search'))?.status && store.get(at('frontend/web-app'))?.status);
  const top = await explorer.getChildren(undefined);
  assert.deepEqual(top.map(n => n.uri.fsPath), roots);
  assert.match(explorer.getTreeItem(top[0]).contextValue ?? '', /\broot\b/);
  explorer.setFilters(['behind']);
  try {
    assert.deepEqual((await explorer.getChildren(undefined)).map(n => n.uri.fsPath), [at('services'), at('services/search')]);
  } finally {
    explorer.setFilters([]);
  }
});

test('a workspace folder that can\'t be read is marked, as in the built-in Explorer', async ({ explorer, items }) => {
  assert.deepEqual(await explorer.getChildren(row('missing', true)), []);
  const mark = items.provideFileDecoration(toViewUri(at('missing')));
  assert.equal(mark?.badge, '!');
  assert.match(mark?.tooltip ?? '', /^Unable to resolve workspace folder \(.+\)$/);
});

test('rows find their parents up to their workspace folder, and reveal walks down from it', async ({ explorer }) => {
  const tree = (explorer as unknown as { treeView: vscode.TreeView<ExplorerNode> }).treeView;
  assert.equal(explorer.getParent(row('services', true)), undefined, 'a workspace folder is at the top');
  assert.equal(explorer.getParent(row('services/api-gateway', true))?.uri.fsPath, at('services'));
  assert.equal(explorer.getParent(row('services/search/README.md'))?.uri.fsPath, at('services/search'), 'the innermost workspace folder');
  await vscode.commands.executeCommand('workbench.view.extension.multiGitExplorer');
  await explorer.reveal(vscode.Uri.file(at('services/api-gateway/src/index.ts')), false);
  assert.deepEqual(tree.selection.map(n => n.uri.fsPath), [at('services/api-gateway/src/index.ts')]);
});

test('paths start with the workspace folder\'s name', async () => {
  const clipboard = await vscode.env.clipboard.readText();
  const searches: unknown[] = [];
  const execute = vscode.commands.executeCommand;
  const restore = stub(vscode.commands, 'executeCommand', ((id: string, ...args: unknown[]) => {
    if (id !== 'workbench.action.findInFiles') return execute(id, ...args);
    searches.push(args[0]);
    return Promise.resolve();
  }) as never);
  try {
    await vscode.commands.executeCommand('multiGitExplorer.copyRelativePath', row('services/api-gateway/README.md'));
    assert.equal(await vscode.env.clipboard.readText(), ['services', 'api-gateway', 'README.md'].join(path.sep));
    await vscode.commands.executeCommand('multiGitExplorer.copyRelativePath', row('frontend', true));
    assert.equal(await vscode.env.clipboard.readText(), 'frontend');
    await vscode.commands.executeCommand('multiGitExplorer.findInFolder', row('services/api-gateway', true));
    assert.deepEqual(searches, [{ filesToInclude: './services/api-gateway', triggerSearch: true }]);
  } finally {
    restore();
    await vscode.env.clipboard.writeText(clipboard);
  }
});

test('Remove Folder from Workspace keeps the other folders, and Add Folder asks VS Code', async () => {
  const updates: unknown[][] = [];
  const added: string[] = [];
  const execute = vscode.commands.executeCommand;
  const restore = [
    stub(vscode.workspace, 'updateWorkspaceFolders', ((...args: unknown[]) => updates.push(args) > 0) as never),
    stub(vscode.commands, 'executeCommand', ((id: string, ...args: unknown[]) => {
      if (id !== 'workbench.action.addRootFolder') return execute(id, ...args);
      added.push(id);
      return Promise.resolve();
    }) as never),
  ];
  try {
    await vscode.commands.executeCommand('multiGitExplorer.removeRootFolder', row('frontend', true));
    await vscode.commands.executeCommand('multiGitExplorer.addRootFolder');
  } finally {
    restore.forEach(r => r());
  }
  assert.deepEqual(
    updates.map(([start, count, ...kept]) => [start, count, ...(kept as { uri: vscode.Uri }[]).map(k => k.uri.fsPath)]),
    [[0, 4, at('services'), at('services/search'), at('missing')]],
  );
  assert.deepEqual(added, ['workbench.action.addRootFolder']);
});

test('changing the workspace folders updates the tree, and repo rows of a workspace folder are named by it', async ({ store, explorer, reposView }) => {
  // A provider that was never given a view follows along too.
  const memento = { get: (_: string, d: unknown) => d, update: async () => undefined, keys: () => [] } as unknown as vscode.Memento;
  const detached = new RepoExplorerProvider(store, memento);
  try {
    const changed = new Promise<void>(resolve => {
      const sub = vscode.workspace.onDidChangeWorkspaceFolders(() => {
        sub.dispose();
        resolve();
      });
    });
    const missing = vscode.workspace.workspaceFolders!.findIndex(f => f.uri.fsPath === at('missing'));
    assert.ok(vscode.workspace.updateWorkspaceFolders(missing, 1));
    await changed;
    assert.ok(!(await explorer.getChildren(undefined)).some(n => n.uri.fsPath === at('missing')));
  } finally {
    detached.dispose();
  }
  assert.equal(reposView.getTreeItem({ type: 'repo', root: at('services/search') }).label, 'search');
});

export const run = (): Promise<void> => runAll('multi-root');
