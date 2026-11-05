import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { appendFileSync, existsSync, rmSync, statSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { MultiRepoGitApi } from '../extension';
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

const tests: [string, (api: MultiRepoGitApi) => Promise<void>][] = [];
const test = (name: string, fn: (api: MultiRepoGitApi) => Promise<void>) => tests.push([name, fn]);

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
  assert.equal((repo?.color as vscode.ThemeColor).id, 'multiRepoGit.conflictForeground');
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

test('multiRepoGit.decorateExplorer turns on badges in the built-in Explorer', async ({ decorations }) => {
  const config = vscode.workspace.getConfiguration('multiRepoGit');
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
    const multiRepoGit = vscode.workspace.getConfiguration('multiRepoGit');
    const files = vscode.workspace.getConfiguration('files');
    const exclude = multiRepoGit.get<string[]>('exclude', []);
    await multiRepoGit.update('exclude', [...exclude, 'src'], vscode.ConfigurationTarget.Global);
    await files.update('exclude', { '**/NOTES.md': true }, vscode.ConfigurationTarget.Global);
    try {
      assert.deepEqual(await names(api), ['README.md']);
    } finally {
      await multiRepoGit.update('exclude', undefined, vscode.ConfigurationTarget.Global);
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
  await vscode.commands.executeCommand('multiRepoGit.filterChanges');
  assert.deepEqual(explorer.activeFilters, ['changes']);
  await vscode.commands.executeCommand('multiRepoGit.filterBehind');
  assert.deepEqual(explorer.activeFilters, ['changes', 'behind']);
  await vscode.commands.executeCommand('multiRepoGit.filterChangesOn');
  assert.deepEqual(explorer.activeFilters, ['behind']);
  await vscode.commands.executeCommand('multiRepoGit.filterBehindOn');
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
    assert.equal(item.command?.command, 'multiRepoGit.openChange');
    await vscode.commands.executeCommand(item.command!.command, ...item.command!.arguments!);
    let diff = activeDiff();
    assert.equal(diff.modified.fsPath, at('services/api-gateway/README.md'));
    const head = execFileSync('git', ['show', 'HEAD:README.md'], { cwd: at('services/api-gateway'), encoding: 'utf8' });
    assert.equal((await vscode.workspace.openTextDocument(diff.original)).getText(), head);

    const routes = await child(await child(api, 'src'), 'routes.ts');
    await vscode.commands.executeCommand('multiRepoGit.openChange', routes);
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
    const done = vscode.commands.executeCommand('multiRepoGit.switchBranch', vscode.Uri.file(root));
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
  await vscode.commands.executeCommand('multiRepoGit.switchBranch', vscode.Uri.file(billing));
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

test('scanning a folder past the depth limit adds its repos', async ({ store }) => {
  await vscode.commands.executeCommand('multiRepoGit.scanFolder', vscode.Uri.file(at('archive/2023/q1')));
  assert.ok(store.get(at('archive/2023/q1/old-crm')));
  await waitFor('300 repos', () => store.all().length === 300);
});

test('Open in Source Control opens the repo in VS Code Git', async () => {
  const uri = vscode.Uri.file(at('services/auth-service'));
  await vscode.commands.executeCommand('multiRepoGit.openInScm', uri);
  const git = vscode.extensions.getExtension('vscode.git')!.exports.getAPI(1);
  assert.ok(git.getRepository(uri), 'repo is open in VS Code Git');
});

test('the file tree is titled Files, with the project name as written beside it', async ({ explorer }) => {
  const manifest = vscode.extensions.getExtension('local.multi-repo-explorer')!.packageJSON;
  const container = manifest.contributes.viewsContainers.activitybar.find((c: { id: string }) => c.id === 'multiRepoGit');
  assert.equal(container.title, 'Repo Explorer');
  // VS Code uppercases titles but not descriptions, so the name is the description.
  assert.equal(explorer.title, 'Files');
  assert.equal(explorer.description, path.basename(sample));
});

test('New File and New Folder create items in the chosen folder and open the file', async () => {
  const docs = at('docs');
  const target: ExplorerNode = { uri: vscode.Uri.file(docs), isDir: true };
  try {
    await vscode.commands.executeCommand('multiRepoGit.newFile', target, 'guides/setup.md');
    assert.ok(existsSync(path.join(docs, 'guides', 'setup.md')), 'nested file created');
    assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, path.join(docs, 'guides', 'setup.md'));

    await vscode.commands.executeCommand('multiRepoGit.newFolder', target, 'images');
    assert.ok(statSync(path.join(docs, 'images')).isDirectory(), 'folder created');

    // A file chosen as the target means "next to this file".
    await vscode.commands.executeCommand('multiRepoGit.newFile', { uri: vscode.Uri.file(path.join(docs, 'README.md')), isDir: false }, 'CHANGELOG.md');
    assert.ok(existsSync(path.join(docs, 'CHANGELOG.md')));

    // Existing names and paths outside the folder are refused.
    await vscode.commands.executeCommand('multiRepoGit.newFile', target, 'README.md');
    await vscode.commands.executeCommand('multiRepoGit.newFile', target, '../escape.md');
    assert.ok(!existsSync(at('escape.md')));
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    for (const item of ['guides', 'images', 'CHANGELOG.md']) rmSync(path.join(docs, item), { recursive: true, force: true });
  }
});

test('every command in package.json is registered', async () => {
  const manifest = vscode.extensions.getExtension('local.multi-repo-explorer')!.packageJSON;
  const registered = new Set(await vscode.commands.getCommands(true));
  for (const { command } of manifest.contributes.commands) assert.ok(registered.has(command), command);
});

export async function run(): Promise<void> {
  const api = await vscode.extensions.getExtension<MultiRepoGitApi>('local.multi-repo-explorer')!.activate();
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
