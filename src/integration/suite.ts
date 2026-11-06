import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { MultiGitExplorerApi } from '../extension';
import type { ExplorerNode } from '../views/repoExplorer';
import { toViewUri } from '../views/viewUri';

const sample = process.env.SAMPLE_WORKSPACE!;
const at = (...parts: string[]) => path.join(sample, ...parts);

async function waitFor<T>(what: string, check: () => T | undefined | false, timeoutMs = 30_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 50));
  }
}

const tests: [string, (api: MultiGitExplorerApi) => Promise<void>][] = [];
const test = (name: string, fn: (api: MultiGitExplorerApi) => Promise<void>) => tests.push([name, fn]);

test('finds every repo within the depth limit and checks them all', async ({ store }) => {
  const started = Date.now();
  await waitFor('discovery', () => store.all().length === 299);
  const found = Date.now() - started;
  await waitFor('all status checks', () => store.progress().done === 299);
  console.log(`    discovery ${found} ms, all 299 checked after ${Date.now() - started} ms`);
});

test('each sample repo gets the expected state', async ({ store }) => {
  const expect = (rel: string, kind: string, badge: string | undefined, description: string) => {
    const repo = store.get(at(rel));
    assert.ok(repo, `${rel} found`);
    assert.equal(repo.view.kind, kind, `${rel} kind`);
    assert.equal(repo.view.badge, badge, `${rel} badge`);
    assert.equal(repo.view.description, description, `${rel} description`);
  };
  expect('services/api-gateway', 'dirty', '4', '⎇ main · ●2 +1 ?1');
  expect('services/auth-service', 'ahead', '↑2', '⎇ feat/sso · ↑2 · ≡1');
  expect('services/billing', 'conflict', '!', '⎇ main · MERGING · ✕1 · ↑1');
  expect('services/search', 'behind', '↓4', '⎇ main · ↓4');
  expect('services/payments', 'diverged', '↕', '⎇ main · ↑2 ↓3');
  expect('services/notification', 'clean', undefined, '⎇ main');
  expect('services/mobile-api', 'noUpstream', '↑', '⎇ fix/login · no upstream');
  expect('services/reports', 'dirty', '9+', '⎇ main · ?12');
  expect('services/catalog', 'conflict', '!', '⎇ topic · REBASING 1/2 · ✕1');
  expect('frontend/web-app', 'clean', undefined, '⎇ main');
  expect('frontend/local-sandbox', 'clean', undefined, '⎇ main');
  assert.match(store.get(at('frontend/design-system'))!.view.description, /\(detached\) · ●1$/);
});

test('badges show in our views but leave the built-in Explorer alone by default', async ({ decorations }) => {
  const view = (rel: string) => decorations.provideFileDecoration(toViewUri(at(rel)));
  const repo = view('services/billing');
  assert.equal(repo?.badge, '!');
  assert.equal((repo?.color as vscode.ThemeColor).id, 'multiGitExplorer.conflictForeground');
  assert.equal(repo?.propagate, true);
  assert.match(repo!.tooltip!, /Merge in progress/);
  assert.equal(view('docs'), undefined);
  const clean = view('services/notification');
  assert.equal(clean?.badge, undefined);
  assert.equal(clean?.propagate, false);

  assert.equal(view('services/api-gateway/src/index.ts')?.badge, 'M');
  assert.equal(view('services/api-gateway/src/routes.ts')?.badge, 'A');
  assert.equal(view('services/api-gateway/NOTES.md')?.badge, 'U');
  assert.equal(view('services/billing/README.md')?.badge, '!');
  assert.equal(view('services/api-gateway/package.json'), undefined, 'unchanged file');

  assert.equal(decorations.provideFileDecoration(vscode.Uri.file(at('services/billing'))), undefined);
});

test('multiGitExplorer.decorateExplorer turns on badges in the built-in Explorer', async ({ decorations }) => {
  const config = vscode.workspace.getConfiguration('multiGitExplorer');
  await config.update('decorateExplorer', true, vscode.ConfigurationTarget.Global);
  try {
    assert.equal(decorations.provideFileDecoration(vscode.Uri.file(at('services/billing')))?.badge, '!');
    assert.equal(decorations.provideFileDecoration(vscode.Uri.file(at('services/api-gateway/src/index.ts'))), undefined);
  } finally {
    await config.update('decorateExplorer', undefined, vscode.ConfigurationTarget.Global);
  }
});

test('Repo Explorer writes branch and state after folder names', async ({ explorer }) => {
  const byName = async (parent: ExplorerNode | undefined, name: string) => {
    const child = (await explorer.getChildren(parent)).find(n => path.basename(n.uri.fsPath) === name);
    assert.ok(child, `${name} listed`);
    return child;
  };
  const describe = (node: ExplorerNode) => explorer.getTreeItem(node);

  const services = await byName(undefined, 'services');
  assert.equal(describe(services).description, '9 repos · !2 ●2 ↑2 ↓2');
  const auth = await byName(services, 'auth-service');
  assert.equal(describe(auth).description, '⎇ feat/sso · ↑2 · ≡1');
  assert.match(describe(auth).contextValue!, /\bcanPush\b/);
  const src = await byName(auth, 'src');
  assert.equal(describe(src).description, undefined, 'folders inside a repo stay plain');
  assert.equal(describe(await byName(undefined, 'docs')).description, 'no git');

  const archive = await byName(undefined, 'archive');
  assert.match(String(describe(archive).description), /^\d+ repos · all clean$/);
  const q1 = await byName(await byName(archive, '2023'), 'q1');
  assert.equal(describe(q1).description, 'not scanned');
  assert.match(describe(q1).contextValue!, /\bunscanned\b/);
  assert.equal(describe(await byName(undefined, '.remotes')).description, 'excluded');
});

test('filtering the Repo Explorer to changed files', async ({ explorer }) => {
  const names = async (node?: ExplorerNode) => (await explorer.getChildren(node)).map(n => path.basename(n.uri.fsPath));
  const child = async (node: ExplorerNode | undefined, name: string) =>
    (await explorer.getChildren(node)).find(n => path.basename(n.uri.fsPath) === name)!;
  try {
    explorer.setFilters(['changes']);
    assert.deepEqual(await names(), ['frontend', 'services']);
    const services = await child(undefined, 'services');
    assert.equal(explorer.getTreeItem(services).description, '4 repos · !2 ●2');
    assert.equal(explorer.getTreeItem(services).collapsibleState, vscode.TreeItemCollapsibleState.Expanded);
    assert.deepEqual(await names(services), ['api-gateway', 'billing', 'catalog', 'reports']);

    const api = await child(services, 'api-gateway');
    assert.deepEqual(await names(api), ['src', 'NOTES.md', 'README.md']);
    const src = await child(api, 'src');
    assert.deepEqual(await names(src), ['index.ts', 'routes.ts']);
    assert.equal(explorer.getTreeItem(await child(src, 'routes.ts')).description, 'staged');
    assert.equal(explorer.getTreeItem(await child(await child(services, 'billing'), 'README.md')).description, 'conflict');
    assert.equal((await names(await child(services, 'reports'))).length, 12);

    // Changes under excluded folders and files.exclude names are left out too.
    const multiGitExplorer = vscode.workspace.getConfiguration('multiGitExplorer');
    const files = vscode.workspace.getConfiguration('files');
    const exclude = multiGitExplorer.get<string[]>('exclude', []);
    await multiGitExplorer.update('exclude', [...exclude, 'src'], vscode.ConfigurationTarget.Global);
    await files.update('exclude', { '**/NOTES.md': true }, vscode.ConfigurationTarget.Global);
    try {
      assert.deepEqual(await names(api), ['README.md']);
    } finally {
      await multiGitExplorer.update('exclude', undefined, vscode.ConfigurationTarget.Global);
      await files.update('exclude', undefined, vscode.ConfigurationTarget.Global);
    }
    assert.deepEqual(await names(api), ['src', 'NOTES.md', 'README.md']);

    explorer.setFilters(['unpushed']);
    assert.deepEqual(await names(), ['services']);
    assert.deepEqual(await names(await child(undefined, 'services')), ['auth-service', 'billing', 'mobile-api', 'payments']);
    const auth = await child(await child(undefined, 'services'), 'auth-service');
    assert.equal(explorer.getTreeItem(auth).collapsibleState, vscode.TreeItemCollapsibleState.None, 'no files to show');

    explorer.setFilters(['changes', 'behind']);
    assert.deepEqual(await names(await child(undefined, 'services')), ['api-gateway', 'billing', 'catalog', 'payments', 'reports', 'search']);
  } finally {
    explorer.setFilters([]);
  }
  assert.ok((await names()).includes('docs'), 'everything is back after clearing the filter');
});

test('title-bar buttons turn each filter on and off with one click', async ({ explorer }) => {
  await vscode.commands.executeCommand('multiGitExplorer.filterChanges');
  assert.deepEqual(explorer.activeFilters, ['changes']);
  await vscode.commands.executeCommand('multiGitExplorer.filterBehind');
  assert.deepEqual(explorer.activeFilters, ['changes', 'behind']);
  await vscode.commands.executeCommand('multiGitExplorer.filterChangesOn');
  assert.deepEqual(explorer.activeFilters, ['behind']);
  await vscode.commands.executeCommand('multiGitExplorer.filterBehindOn');
  assert.deepEqual(explorer.activeFilters, []);
});

test('clicking a changed file while filtered opens a diff against HEAD', async ({ explorer }) => {
  const child = async (node: ExplorerNode | undefined, name: string) =>
    (await explorer.getChildren(node)).find(n => path.basename(n.uri.fsPath) === name)!;
  const activeDiff = () => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    assert.ok(input instanceof vscode.TabInputTextDiff, 'a diff editor is open');
    return input;
  };
  try {
    explorer.setFilters(['changes']);
    const api = await child(await child(undefined, 'services'), 'api-gateway');

    const readme = await child(api, 'README.md');
    const item = explorer.getTreeItem(readme);
    assert.equal(item.command?.command, 'multiGitExplorer.openChange');
    await vscode.commands.executeCommand(item.command!.command, ...item.command!.arguments!);
    let diff = activeDiff();
    assert.equal(diff.modified.fsPath, at('services/api-gateway/README.md'));
    const head = execFileSync('git', ['show', 'HEAD:README.md'], { cwd: at('services/api-gateway'), encoding: 'utf8' });
    assert.equal((await vscode.workspace.openTextDocument(diff.original)).getText(), head);

    const routes = await child(await child(api, 'src'), 'routes.ts');
    await vscode.commands.executeCommand('multiGitExplorer.openChange', routes);
    diff = activeDiff();
    assert.equal((await vscode.workspace.openTextDocument(diff.original)).getText(), '', 'new file: empty left side');
  } finally {
    explorer.setFilters([]);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }
});

test('Switch Branch lists branches and switches to the picked one', async ({ store }) => {
  const root = at('services/auth-service');
  const branch = () => execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(branch(), 'feat/sso');
  try {
    // Items: Create new…, Create from…, feat/sso (current, newest), main.
    const done = vscode.commands.executeCommand('multiGitExplorer.switchBranch', vscode.Uri.file(root));
    await new Promise(r => setTimeout(r, 1500));
    for (let i = 0; i < 3; i++) await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    await done;
    assert.equal(branch(), 'main');
    await waitFor('the view to show main', () => store.get(root)?.view.branchLabel === 'main', 10_000);
  } finally {
    execFileSync('git', ['switch', '-q', 'feat/sso'], { cwd: root });
    await waitFor('the view to show feat/sso again', () => store.get(root)?.view.kind === 'ahead', 10_000);
  }
});

test('Switch Branch refuses while a merge is in progress', async () => {
  const billing = at('services/billing');
  const before = execFileSync('git', ['branch', '--show-current'], { cwd: billing, encoding: 'utf8' }).trim();
  await vscode.commands.executeCommand('multiGitExplorer.switchBranch', vscode.Uri.file(billing));
  assert.equal(execFileSync('git', ['branch', '--show-current'], { cwd: billing, encoding: 'utf8' }).trim(), before);
});

test('Git Repos view groups problems first and filters', async ({ reposView }) => {
  const groups = reposView.getChildren().map(n => (n.type === 'group' ? n.key : ''));
  assert.deepEqual(groups, ['conflict', 'dirty', 'unpushed', 'behind', 'clean']);
  const count = (key: string) => reposView.getTreeItem({ type: 'group', key: key as never }).description;
  assert.equal(count('conflict'), '2');
  assert.equal(count('dirty'), '3');
  assert.equal(count('clean'), '290');

  reposView.setFilter('sso');
  const filtered = reposView.getChildren();
  assert.deepEqual(filtered.map(n => (n.type === 'group' ? n.key : '')), ['unpushed']);
  const rows = reposView.getChildren(filtered[0]).map(n => reposView.getTreeItem(n).label);
  assert.deepEqual(rows, ['services/auth-service']);
  reposView.setFilter('');
});

test('editing a file is picked up by the file watcher', async ({ store }) => {
  const root = at('services/notification');
  appendFileSync(path.join(root, 'README.md'), 'edit\n');
  await waitFor('notification to become dirty', () => store.get(root)?.view.kind === 'dirty', 10_000);
  execFileSync('git', ['checkout', '--', 'README.md'], { cwd: root });
  await waitFor('notification to be clean again', () => store.get(root)?.view.kind === 'clean', 10_000);
});

test('committing from outside VS Code is picked up from .git', async ({ store }) => {
  const root = at('services/notification');
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  appendFileSync(path.join(root, 'README.md'), 'commit\n');
  execFileSync('git', ['commit', '-qam', 'from terminal'], { cwd: root, env });
  await waitFor('notification to be ahead', () => store.get(root)?.view.kind === 'ahead', 10_000);
  execFileSync('git', ['reset', '-q', '--hard', 'HEAD~1'], { cwd: root });
  await waitFor('notification to be clean again', () => store.get(root)?.view.kind === 'clean', 10_000);
});

test('opening a folder past the depth limit searches it for repos', async ({ store, explorer }) => {
  const q1 = (await explorer.getChildren({ uri: vscode.Uri.file(at('archive/2023')), isDir: true })).find(
    n => path.basename(n.uri.fsPath) === 'q1',
  )!;
  assert.equal(explorer.getTreeItem(q1).description, 'not scanned');
  await explorer.getChildren(q1);
  await waitFor('old-crm to be found', () => store.get(at('archive/2023/q1/old-crm')));
  await waitFor('300 repos', () => store.all().length === 300);
  await waitFor('q1 to show its repo', () => explorer.getTreeItem(q1).description === '1 repo · all clean');
});

test('Scan This Folder searches a folder past the depth limit', async ({ store }) => {
  await vscode.commands.executeCommand('multiGitExplorer.scanFolder', vscode.Uri.file(at('archive/2023/q1')));
  assert.ok(store.get(at('archive/2023/q1/old-crm')));
});

test('Open in Source Control opens the repo in VS Code Git', async () => {
  const uri = vscode.Uri.file(at('services/auth-service'));
  await vscode.commands.executeCommand('multiGitExplorer.openInScm', uri);
  const git = vscode.extensions.getExtension('vscode.git')!.exports.getAPI(1);
  assert.ok(git.getRepository(uri), 'repo is open in VS Code Git');
});

test('the file tree is titled Files, with the project name as written beside it', async ({ explorer }) => {
  const manifest = vscode.extensions.getExtension('prateep-r.multi-git-explorer')!.packageJSON;
  const container = manifest.contributes.viewsContainers.activitybar.find((c: { id: string }) => c.id === 'multiGitExplorer');
  assert.equal(container.title, 'Multi-Git Explorer');
  // VS Code uppercases titles but not descriptions, so the name is the description.
  assert.equal(explorer.title, 'Files');
  assert.equal(explorer.description, path.basename(sample));
});

test('New File and New Folder create items in the chosen folder and open the file', async () => {
  const docs = at('docs');
  const target: ExplorerNode = { uri: vscode.Uri.file(docs), isDir: true };
  try {
    await vscode.commands.executeCommand('multiGitExplorer.newFile', target, 'guides/setup.md');
    assert.ok(existsSync(path.join(docs, 'guides', 'setup.md')), 'nested file created');
    assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, path.join(docs, 'guides', 'setup.md'));

    await vscode.commands.executeCommand('multiGitExplorer.newFolder', target, 'images');
    assert.ok(statSync(path.join(docs, 'images')).isDirectory(), 'folder created');

    // A file chosen as the target means "next to this file".
    await vscode.commands.executeCommand('multiGitExplorer.newFile', { uri: vscode.Uri.file(path.join(docs, 'README.md')), isDir: false }, 'CHANGELOG.md');
    assert.ok(existsSync(path.join(docs, 'CHANGELOG.md')));

    // Existing names and paths outside the folder are refused.
    await vscode.commands.executeCommand('multiGitExplorer.newFile', target, 'README.md');
    await vscode.commands.executeCommand('multiGitExplorer.newFile', target, '../escape.md');
    assert.ok(!existsSync(at('escape.md')));
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    for (const item of ['guides', 'images', 'CHANGELOG.md']) rmSync(path.join(docs, item), { recursive: true, force: true });
  }
});

/** Warning dialogs shown by `withScratch` tests, which answer each with its last button. */
const dialogs: string[] = [];

/** Runs `fn` with a scratch folder in docs/ holding a.txt and sub/, and settings that skip confirmations. */
async function withScratch(fn: (dir: string, node: (rel: string, isDir?: boolean) => ExplorerNode) => Promise<void>) {
  const dir = at('docs', 'scratch');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(dir, 'sub'), { recursive: true });
  writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  const settings: [string, string, unknown][] = [
    ['explorer', 'confirmDelete', false],
    ['explorer', 'confirmDragAndDrop', false],
    ['files', 'enableTrash', false],
  ];
  for (const [section, key, value] of settings) {
    await vscode.workspace.getConfiguration(section).update(key, value, vscode.ConfigurationTarget.Global);
  }
  const clipboard = await vscode.env.clipboard.readText();
  // Tests can't show modal dialogs, so answer them as the user would.
  const window = vscode.window as { showWarningMessage: (...args: unknown[]) => Thenable<unknown> };
  const showWarning = window.showWarningMessage;
  window.showWarningMessage = async (message: unknown, ...rest: unknown[]) => {
    dialogs.push(String(message));
    return rest[rest.length - 1];
  };
  dialogs.length = 0;
  try {
    await fn(dir, (rel, isDir = false) => ({ uri: vscode.Uri.file(path.join(dir, rel)), isDir }));
  } finally {
    window.showWarningMessage = showWarning;
    await vscode.env.clipboard.writeText(clipboard);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    for (const [section, key] of settings) {
      await vscode.workspace.getConfiguration(section).update(key, undefined, vscode.ConfigurationTarget.Global);
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

test('Copy, Cut and Paste copy and move items like the built-in Explorer', () =>
  withScratch(async (dir, node) => {
    await vscode.commands.executeCommand('multiGitExplorer.copy', node('a.txt'));
    await vscode.commands.executeCommand('multiGitExplorer.paste', node('sub', true));
    assert.ok(existsSync(path.join(dir, 'sub', 'a.txt')), 'pasted into the folder');
    await vscode.commands.executeCommand('multiGitExplorer.paste', node('a.txt'));
    assert.ok(existsSync(path.join(dir, 'a copy.txt')), 'pasting next to the original names a copy');
    await vscode.commands.executeCommand('multiGitExplorer.paste', node('a.txt'));
    assert.ok(existsSync(path.join(dir, 'a copy 2.txt')));

    await vscode.commands.executeCommand('multiGitExplorer.copy', node('sub', true));
    await vscode.commands.executeCommand('multiGitExplorer.paste', node('sub', true));
    assert.ok(!existsSync(path.join(dir, 'sub', 'sub')), 'a folder is not pasted into itself');

    await vscode.commands.executeCommand('multiGitExplorer.cut', node('a copy.txt'), [node('a copy.txt'), node('a copy 2.txt')]);
    await vscode.commands.executeCommand('multiGitExplorer.paste', node('sub', true));
    assert.ok(existsSync(path.join(dir, 'sub', 'a copy.txt')) && existsSync(path.join(dir, 'sub', 'a copy 2.txt')), 'both moved');
    assert.ok(!existsSync(path.join(dir, 'a copy.txt')), 'cut removes the original');
  }));

test('Rename and Delete change files, and drag and drop moves them', ({ files }) =>
  withScratch(async (dir, node) => {
    await vscode.commands.executeCommand('multiGitExplorer.rename', node('a.txt'), 'b.txt');
    assert.ok(existsSync(path.join(dir, 'b.txt')) && !existsSync(path.join(dir, 'a.txt')));
    await vscode.commands.executeCommand('multiGitExplorer.rename', node('b.txt'), 'sub');
    assert.ok(existsSync(path.join(dir, 'b.txt')), 'a taken name is refused');

    const transfer = new vscode.DataTransfer();
    await files.dragAndDrop.handleDrag!([node('b.txt')], transfer, new vscode.CancellationTokenSource().token);
    await files.dragAndDrop.handleDrop!(node('sub', true), transfer, new vscode.CancellationTokenSource().token);
    assert.ok(existsSync(path.join(dir, 'sub', 'b.txt')), 'dropped into the folder');

    await vscode.commands.executeCommand('multiGitExplorer.delete', node('sub', true));
    assert.ok(!existsSync(path.join(dir, 'sub')));
    assert.deepEqual(dialogs, ["Are you sure you want to permanently delete 'sub'?"], 'deleting without the trash always asks');
  }));

test('Copy Path, Copy Relative Path, compare and open to the side', () =>
  withScratch(async (dir, node) => {
    writeFileSync(path.join(dir, 'b.txt'), 'b\n');
    await vscode.commands.executeCommand('multiGitExplorer.copyPath', node('a.txt'), [node('a.txt'), node('b.txt')]);
    assert.equal(await vscode.env.clipboard.readText(), `${path.join(dir, 'a.txt')}\n${path.join(dir, 'b.txt')}`);
    await vscode.commands.executeCommand('multiGitExplorer.copyRelativePath', node('a.txt'));
    assert.equal(await vscode.env.clipboard.readText(), path.join('docs', 'scratch', 'a.txt'));

    await vscode.commands.executeCommand('multiGitExplorer.selectForCompare', node('a.txt'));
    await vscode.commands.executeCommand('multiGitExplorer.compareWithSelected', node('b.txt'));
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(tab?.input instanceof vscode.TabInputTextDiff, 'a diff opened');
    assert.equal(tab.label, 'a.txt ↔ b.txt');

    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(dir, 'b.txt')));
    await vscode.commands.executeCommand('multiGitExplorer.openToSide', node('a.txt'));
    assert.equal(vscode.window.tabGroups.all.length, 2, 'opened in a second editor group');
  }));

test('Copy Remote File URL links to the file on the remote website', async () => {
  const root = at('services/api-gateway');
  const original = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root }).toString().trim();
  const clipboard = await vscode.env.clipboard.readText();
  execFileSync('git', ['remote', 'set-url', 'origin', 'git@github.com:acme/api-gateway.git'], { cwd: root });
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root }).toString().trim();
    await vscode.commands.executeCommand('multiGitExplorer.copyRemoteUrl', { uri: vscode.Uri.file(path.join(root, 'src', 'index.ts')), isDir: false });
    assert.equal(await vscode.env.clipboard.readText(), `https://github.com/acme/api-gateway/blob/${branch}/src/index.ts`);
  } finally {
    execFileSync('git', ['remote', 'set-url', 'origin', original], { cwd: root });
    await vscode.env.clipboard.writeText(clipboard);
  }
});

test('keyboard shortcuts, which pass no row, act on the selected rows', ({ explorer }) =>
  withScratch(async dir => {
    await explorer.reveal(vscode.Uri.file(path.join(dir, 'a.txt')), false);
    await vscode.commands.executeCommand('multiGitExplorer.copyPath');
    assert.equal(await vscode.env.clipboard.readText(), path.join(dir, 'a.txt'));
    await vscode.commands.executeCommand('multiGitExplorer.copy');
    await explorer.reveal(vscode.Uri.file(path.join(dir, 'sub')), true);
    await vscode.commands.executeCommand('multiGitExplorer.paste');
    assert.ok(existsSync(path.join(dir, 'sub', 'a.txt')), 'pasted into the selected folder');
  }));

test('rows of deleted files are left alone by commands that need the file', () =>
  withScratch(async (dir, node) => {
    const deleted: ExplorerNode = { ...node('gone.txt'), change: { path: 'gone.txt', letter: 'D', staged: false, unstaged: true } };
    await vscode.commands.executeCommand('multiGitExplorer.rename', deleted, 'back.txt');
    await vscode.commands.executeCommand('multiGitExplorer.copy', deleted);
    await vscode.commands.executeCommand('multiGitExplorer.paste', node('sub', true));
    assert.ok(!existsSync(path.join(dir, 'back.txt')) && !existsSync(path.join(dir, 'sub', 'gone.txt')));
    assert.deepEqual(dialogs, [], 'no dialog either');
  }));

test('moving onto an existing name asks before replacing it', () =>
  withScratch(async (dir, node) => {
    writeFileSync(path.join(dir, 'sub', 'a.txt'), 'old\n');
    await vscode.commands.executeCommand('multiGitExplorer.cut', node('a.txt'));
    await vscode.commands.executeCommand('multiGitExplorer.paste', node('sub', true));
    assert.deepEqual(dialogs, ["'a.txt' already exists in 'sub'. Do you want to replace it?"]);
    assert.equal(readFileSync(path.join(dir, 'sub', 'a.txt'), 'utf8'), 'a\n', 'replaced');
    assert.ok(!existsSync(path.join(dir, 'a.txt')));
  }));

test('Open in Integrated Terminal, Find in Folder and Open Timeline run on a row', () =>
  withScratch(async (dir, node) => {
    await vscode.commands.executeCommand('multiGitExplorer.openInTerminal', node('a.txt'));
    const terminal = vscode.window.terminals.find(t => t.name === 'scratch');
    assert.ok(terminal, 'a terminal named after the folder the file is in');
    terminal.dispose();
    await vscode.commands.executeCommand('multiGitExplorer.findInFolder', node('sub', true));
    await vscode.commands.executeCommand('multiGitExplorer.openTimeline', node('a.txt'));
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    assert.ok(tab instanceof vscode.TabInputText && tab.uri.fsPath === path.join(dir, 'a.txt'), 'the file is open for the Timeline view');
  }));

test('a file removed with git rm --cached shows as untracked, not deleted', async ({ store }) => {
  const root = at('services/notification');
  execFileSync('git', ['rm', '-q', '--cached', 'README.md'], { cwd: root });
  try {
    await waitFor('the change to show', () => store.get(root)?.changes?.get('README.md'));
    assert.equal(store.get(root)!.changes!.get('README.md')!.letter, 'U');
  } finally {
    execFileSync('git', ['reset', '-q', 'HEAD', '--', 'README.md'], { cwd: root });
  }
});

test('files.exclude hides items like the built-in Explorer: globs, when clauses, exceptions and open editors', ({ explorer }) =>
  withScratch(async (dir, node) => {
    for (const name of ['a.pyc', 'b.ts', 'b.js', 'c.js']) writeFileSync(path.join(dir, name), '');
    mkdirSync(path.join(dir, 'out'));
    writeFileSync(path.join(dir, 'out', 'keep.txt'), '');
    writeFileSync(path.join(dir, 'out', 'drop.txt'), '');
    mkdirSync(path.join(dir, 'build'));
    writeFileSync(path.join(dir, 'build', 'app.js'), '');
    const config = vscode.workspace.getConfiguration('files');
    const original = config.inspect('exclude')?.globalValue;
    const names = async (rel: string) =>
      (await explorer.getChildren(node(rel, true))).map(n => path.basename(n.uri.fsPath)).sort();
    try {
      await config.update(
        'exclude',
        { '**/.git': true, '**/*.pyc': true, '**/*.js': { when: '$(basename).ts' }, 'docs/scratch/out': true, '!docs/scratch/out/keep.txt': true, 'docs/scratch/build': true },
        vscode.ConfigurationTarget.Global,
      );
      assert.deepEqual(await names('.'), ['a.txt', 'b.ts', 'c.js', 'out', 'sub'], 'globs, when and exceptions');
      assert.deepEqual(await names('out'), ['keep.txt'], 'only the exception inside an excluded folder');
      await vscode.window.showTextDocument(vscode.Uri.file(path.join(dir, 'build', 'app.js')));
      // The tree refreshes when an editor opens an excluded file; ask again until it has.
      for (let i = 0; i < 100 && !(await names('.')).includes('build'); i++) await new Promise(r => setTimeout(r, 50));
      assert.ok((await names('.')).includes('build'), 'an excluded folder shows while an editor shows a file in it');
      assert.deepEqual(await names('build'), ['app.js']);
    } finally {
      await config.update('exclude', original, vscode.ConfigurationTarget.Global);
    }
  }));

test('explorer.sortOrder and its options sort the file tree like the built-in Explorer', ({ explorer }) =>
  withScratch(async (dir, node) => {
    writeFileSync(path.join(dir, 'b.md'), '');
    writeFileSync(path.join(dir, 'C.txt'), '');
    const names = async () => (await explorer.getChildren(node('.', true))).map(n => path.basename(n.uri.fsPath));
    const config = vscode.workspace.getConfiguration('explorer');
    const set = (key: string, value: unknown) => config.update(key, value, vscode.ConfigurationTarget.Global);
    try {
      assert.deepEqual(await names(), ['sub', 'a.txt', 'b.md', 'C.txt'], 'default');
      await set('sortOrder', 'filesFirst');
      assert.deepEqual(await names(), ['a.txt', 'b.md', 'C.txt', 'sub']);
      await set('sortOrder', 'type');
      assert.deepEqual(await names(), ['sub', 'b.md', 'a.txt', 'C.txt']);
      await set('sortOrder', 'default');
      await set('sortOrderLexicographicOptions', 'upper');
      assert.deepEqual(await names(), ['sub', 'C.txt', 'a.txt', 'b.md']);
      await set('sortOrderLexicographicOptions', undefined);
      await set('sortOrderReverse', true);
      assert.deepEqual(await names(), ['C.txt', 'b.md', 'a.txt', 'sub']);
    } finally {
      for (const key of ['sortOrder', 'sortOrderLexicographicOptions', 'sortOrderReverse']) await set(key, undefined);
    }
  }));

test('shortcuts act on the focused row, or the selection it is part of, like the built-in Explorer', ({ explorer }) =>
  withScratch(async (dir, node) => {
    const tree = (explorer as unknown as { treeView: vscode.TreeView<ExplorerNode> }).treeView;
    await vscode.commands.executeCommand('workbench.view.extension.multiGitExplorer');
    await tree.reveal(node('sub', true), { select: true, focus: true });
    await vscode.commands.executeCommand('list.focusDown'); // focus moves to a.txt, the selection stays on sub
    assert.equal((await explorer.focusedRow())?.uri.fsPath, path.join(dir, 'a.txt'));
    assert.deepEqual(tree.selection.map(n => path.basename(n.uri.fsPath)), ['sub'], 'finding the focused row leaves the selection alone');
    await vscode.commands.executeCommand('multiGitExplorer.copyPath', { keyboard: true });
    assert.equal(await vscode.env.clipboard.readText(), path.join(dir, 'a.txt'), 'the focused row, as it is not selected');
    await vscode.commands.executeCommand('list.toggleSelection'); // a.txt joins the selection
    await vscode.commands.executeCommand('multiGitExplorer.copyPath', { keyboard: true });
    assert.equal(await vscode.env.clipboard.readText(), [path.join(dir, 'sub'), path.join(dir, 'a.txt')].join('\n'), 'the whole selection');
    await vscode.commands.executeCommand('multiGitExplorer.openPreserveFocus', { keyboard: true });
    await waitFor('a.txt to open', () => vscode.window.activeTextEditor?.document.uri.fsPath === path.join(dir, 'a.txt'));
  }));

test('files with problems are colored and counted, and cut rows are dimmed, like the built-in Explorer', ({ problems, cut, files }) =>
  withScratch(async (dir, node) => {
    const file = vscode.Uri.file(path.join(dir, 'a.txt'));
    const diagnostics = vscode.languages.createDiagnosticCollection('integration');
    const config = vscode.workspace.getConfiguration('problems');
    try {
      diagnostics.set(file, [
        new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), 'warning', vscode.DiagnosticSeverity.Warning),
        new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), 'error', vscode.DiagnosticSeverity.Error),
      ]);
      const decoration = problems.provideFileDecoration(toViewUri(file.fsPath));
      assert.equal(decoration?.badge, '2');
      assert.equal((decoration?.color as vscode.ThemeColor).id, 'list.errorForeground');
      assert.equal(decoration?.propagate, true, 'folders above are tinted too');
      await config.update('decorations.enabled', false, vscode.ConfigurationTarget.Global);
      assert.equal(problems.provideFileDecoration(toViewUri(file.fsPath)), undefined, 'problems.decorations.enabled');
    } finally {
      await config.update('decorations.enabled', undefined, vscode.ConfigurationTarget.Global);
      diagnostics.dispose();
    }

    await files.setClipboard([node('a.txt')], true);
    assert.equal((cut.provideFileDecoration(toViewUri(file.fsPath))?.color as vscode.ThemeColor).id, 'disabledForeground');
    files.cancelCut();
    assert.equal(cut.provideFileDecoration(toViewUri(file.fsPath)), undefined, 'Escape cancels the cut');
    await files.setClipboard([node('a.txt')], true);
    await files.paste(vscode.Uri.file(path.join(dir, 'sub')));
    assert.equal(cut.provideFileDecoration(toViewUri(path.join(dir, 'sub', 'a.txt'))), undefined, 'pasting ends the cut');
    assert.equal(cut.provideFileDecoration(toViewUri(file.fsPath)), undefined);
  }));

test('the active editor\'s file is selected in the tree, following explorer.autoReveal and autoRevealExclude', ({ explorer }) =>
  withScratch(async dir => {
    const tree = (explorer as unknown as { treeView: vscode.TreeView<ExplorerNode> }).treeView;
    mkdirSync(path.join(dir, 'sub', 'deep'), { recursive: true });
    mkdirSync(path.join(dir, 'gen'));
    for (const file of ['sub/deep/x.txt', 'gen/y.txt', 'sub/z.txt']) writeFileSync(path.join(dir, file), '');
    const config = vscode.workspace.getConfiguration('explorer');
    const selected = () => tree.selection.map(n => n.uri.fsPath).join(',');
    const settle = () => new Promise(r => setTimeout(r, 600));
    await vscode.commands.executeCommand('workbench.view.extension.multiGitExplorer');
    try {
      await config.update('autoReveal', true, vscode.ConfigurationTarget.Global);
      await config.update('autoRevealExclude', { '**/node_modules': true, '**/gen': true }, vscode.ConfigurationTarget.Global);
      await vscode.window.showTextDocument(vscode.Uri.file(path.join(dir, 'sub', 'deep', 'x.txt')));
      await waitFor('x.txt to be selected', () => selected() === path.join(dir, 'sub', 'deep', 'x.txt'));
      await vscode.window.showTextDocument(vscode.Uri.file(path.join(dir, 'gen', 'y.txt')));
      await settle();
      assert.equal(selected(), path.join(dir, 'sub', 'deep', 'x.txt'), 'a file in a folder matching autoRevealExclude is left alone');
      await config.update('autoReveal', false, vscode.ConfigurationTarget.Global);
      await vscode.window.showTextDocument(vscode.Uri.file(path.join(dir, 'sub', 'z.txt')));
      await settle();
      assert.equal(selected(), path.join(dir, 'sub', 'deep', 'x.txt'), 'off when explorer.autoReveal is false');
    } finally {
      await config.update('autoReveal', undefined, vscode.ConfigurationTarget.Global);
      await config.update('autoRevealExclude', undefined, vscode.ConfigurationTarget.Global);
    }
  }));

test('.gitignored files are dimmed like the git extension does, and hidden with explorer.excludeGitIgnore', async ({ explorer, ignored }) => {
  const repo = at('services/notification');
  const names = async (dir: string) =>
    (await explorer.getChildren({ uri: vscode.Uri.file(dir), isDir: true })).map(n => path.basename(n.uri.fsPath));
  const color = async (rel: string) =>
    ((await ignored.provideFileDecoration(toViewUri(path.join(repo, rel))))?.color as vscode.ThemeColor | undefined)?.id;
  assert.equal(await color('dist'), 'gitDecoration.ignoredResourceForeground');
  assert.equal(await color('dist/bundle.js'), 'gitDecoration.ignoredResourceForeground');
  assert.equal(await color('debug.log'), 'gitDecoration.ignoredResourceForeground');
  assert.equal(await color('keep.log'), undefined, 're-included with !');
  assert.equal(await color('README.md'), undefined);
  assert.equal(await ignored.provideFileDecoration(toViewUri(repo)), undefined, 'a repo is never ignored by itself');

  assert.ok((await names(repo)).includes('dist'), 'shown while explorer.excludeGitIgnore is off');
  const config = vscode.workspace.getConfiguration('explorer');
  try {
    await config.update('excludeGitIgnore', true, vscode.ConfigurationTarget.Global);
    const shown = await names(repo);
    assert.ok(!shown.includes('dist') && !shown.includes('debug.log'), `ignored items hidden: ${shown}`);
    assert.ok(shown.includes('keep.log') && shown.includes('src') && shown.includes('.gitignore'));
  } finally {
    await config.update('excludeGitIgnore', undefined, vscode.ConfigurationTarget.Global);
  }
  assert.ok((await names(repo)).includes('dist'));
});

test('explorer.compactFolders shows single-child folders as one row, like the built-in Explorer', ({ explorer }) =>
  withScratch(async (dir, node) => {
    mkdirSync(path.join(dir, 'src', 'main', 'java'), { recursive: true });
    writeFileSync(path.join(dir, 'src', 'main', 'java', 'App.java'), '');
    const config = vscode.workspace.getConfiguration('explorer');
    const tree = (explorer as unknown as { treeView: vscode.TreeView<ExplorerNode> }).treeView;
    const label = (n: ExplorerNode) => explorer.getTreeItem(n).label;
    try {
      await config.update('compactFolders', true, vscode.ConfigurationTarget.Global);
      const src = (await explorer.getChildren(node('.', true))).find(n => path.basename(headOfRow(n)) === 'src')!;
      const children = await explorer.getChildren(src);
      assert.equal(label(src), 'src/main/java', 'opening it takes in the single child folders');
      assert.equal(src.uri.fsPath, path.join(dir, 'src', 'main', 'java'), 'commands act on the last folder');
      assert.deepEqual(children.map(n => path.basename(n.uri.fsPath)), ['App.java']);
      assert.equal(explorer.getParent(children[0]), src, 'the files inside belong to the compact row');

      await explorer.reveal(vscode.Uri.file(path.join(dir, 'src', 'main', 'java', 'App.java')), false);
      assert.equal(tree.selection[0]?.uri.fsPath, path.join(dir, 'src', 'main', 'java', 'App.java'), 'revealing into a compact row');

      // A second entry in a middle folder breaks the chain there.
      writeFileSync(path.join(dir, 'src', 'main', 'notes.md'), '');
      await waitFor('the chain to break', () => src.compact?.length === 2);
      assert.equal(label(src), 'src/main');
      assert.deepEqual((await explorer.getChildren(src)).map(n => path.basename(n.uri.fsPath)), ['java', 'notes.md']);

      await config.update('compactFolders', false, vscode.ConfigurationTarget.Global);
      const plain = (await explorer.getChildren(node('.', true))).find(n => path.basename(n.uri.fsPath) === 'src')!;
      await explorer.getChildren(plain);
      assert.equal(plain.compact, undefined, 'off when explorer.compactFolders is false');
    } finally {
      await config.update('compactFolders', undefined, vscode.ConfigurationTarget.Global);
    }
  }));

/** The first folder of a row, even a compact one. */
function headOfRow(n: ExplorerNode): string {
  return (n.compact?.[0] ?? n.uri).fsPath;
}

test('explorer.fileNesting nests related files under their parent, like the built-in Explorer', ({ explorer }) =>
  withScratch(async (dir, node) => {
    for (const name of ['package.json', 'package-lock.json', 'app.ts', 'app.js', 'other.js']) writeFileSync(path.join(dir, name), '');
    const config = vscode.workspace.getConfiguration('explorer');
    const set = (key: string, value: unknown) => config.update(key, value, vscode.ConfigurationTarget.Global);
    const top = async () => explorer.getChildren(node('.', true));
    try {
      await set('fileNesting.enabled', true);
      await set('fileNesting.patterns', { 'package.json': 'package-lock.json', '*.ts': '${capture}.js' });
      await set('sortOrder', 'foldersNestsFiles');
      const rows = await top();
      assert.deepEqual(rows.map(n => path.basename(n.uri.fsPath)), ['sub', 'app.ts', 'package.json', 'a.txt', 'other.js'], 'nest parents first with foldersNestsFiles');
      const pkg = rows.find(n => path.basename(n.uri.fsPath) === 'package.json')!;
      const nested = await explorer.getChildren(pkg);
      assert.deepEqual(nested.map(n => path.basename(n.uri.fsPath)), ['package-lock.json']);
      assert.equal(explorer.getParent(nested[0]), pkg);
      assert.equal(explorer.getTreeItem(pkg).collapsibleState, vscode.TreeItemCollapsibleState.Expanded, 'open by default (fileNesting.expand)');
      assert.ok(explorer.getTreeItem(pkg).command, 'clicking still opens the file');

      // A closed nest parent takes its nested files along when deleted.
      await set('fileNesting.expand', false);
      await vscode.commands.executeCommand('multiGitExplorer.delete', pkg);
      assert.ok(!existsSync(path.join(dir, 'package.json')) && !existsSync(path.join(dir, 'package-lock.json')));

      await set('fileNesting.enabled', false);
      assert.ok((await top()).some(n => path.basename(n.uri.fsPath) === 'app.js'), 'off: nothing nests');
    } finally {
      for (const key of ['fileNesting.enabled', 'fileNesting.patterns', 'fileNesting.expand', 'sortOrder']) await set(key, undefined);
    }
  }));

test('every command in package.json is registered', async () => {
  const manifest = vscode.extensions.getExtension('prateep-r.multi-git-explorer')!.packageJSON;
  const registered = new Set(await vscode.commands.getCommands(true));
  for (const { command } of manifest.contributes.commands) assert.ok(registered.has(command), command);
});

export async function run(): Promise<void> {
  const api = await vscode.extensions.getExtension<MultiGitExplorerApi>('prateep-r.multi-git-explorer')!.activate();
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn(api);
      console.log(`  ✔ ${name}`);
    } catch (error) {
      failed++;
      console.log(`  ✘ ${name}\n    ${error instanceof Error ? error.message : error}`);
    }
  }
  if (failed) throw new Error(`${failed} of ${tests.length} integration tests failed`);
  console.log(`  ${tests.length} integration tests passed`);
}
