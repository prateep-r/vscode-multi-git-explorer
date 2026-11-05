import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { appendFileSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { MultiRepoGitApi } from '../extension';
import type { ExplorerNode } from '../views/repoExplorer';

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

test('decorations color repo folders and leave other folders alone', async ({ decorations }) => {
  const repo = decorations.provideFileDecoration(vscode.Uri.file(at('services/billing')));
  assert.equal(repo?.badge, '!');
  assert.equal((repo?.color as vscode.ThemeColor).id, 'multiRepoGit.conflictForeground');
  assert.equal(repo?.propagate, true);
  assert.match(repo!.tooltip!, /Merge in progress/);
  assert.equal(decorations.provideFileDecoration(vscode.Uri.file(at('docs'))), undefined);
  const clean = decorations.provideFileDecoration(vscode.Uri.file(at('services/notification')));
  assert.equal(clean?.badge, undefined);
  assert.equal(clean?.propagate, false);
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

test('every command in package.json is registered', async () => {
  const manifest = vscode.extensions.getExtension('local.multi-repo-git-status')!.packageJSON;
  const registered = new Set(await vscode.commands.getCommands(true));
  for (const { command } of manifest.contributes.commands) assert.ok(registered.has(command), command);
});

export async function run(): Promise<void> {
  const api = await vscode.extensions.getExtension<MultiRepoGitApi>('local.multi-repo-git-status')!.activate();
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
