// Checks the hand-off to Claude Code and Codex with those extensions really
// installed. Their chat boxes are webviews we can't read, so this checks what
// is observable: the commands run, the right file is opened, the chat opens,
// and copied @paths are right. The clipboard is restored afterwards.
import assert from 'node:assert/strict';
import * as path from 'path';
import * as vscode from 'vscode';
import type { MultiRepoExplorerApi } from '../extension';
import type { ExplorerNode } from '../views/repoExplorer';

const sample = process.env.SAMPLE_WORKSPACE!;
const at = (...parts: string[]) => path.join(sample, ...parts);

async function waitFor<T>(what: string, check: () => T | undefined | false, timeoutMs = 20_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 100));
  }
}

const webviewTabs = () =>
  vscode.window.tabGroups.all
    .flatMap(g => g.tabs)
    .map(t => t.input)
    .filter((i): i is vscode.TabInputWebview => i instanceof vscode.TabInputWebview)
    .map(i => i.viewType);

const fileNode = (rel: string): ExplorerNode => ({ uri: vscode.Uri.file(at(rel)), isDir: false });
const dirNode = (rel: string): ExplorerNode => ({ uri: vscode.Uri.file(at(rel)), isDir: true });

const tests: [string, () => Promise<void>][] = [];
const test = (name: string, fn: () => Promise<void>) => tests.push([name, fn]);

test('both chat extensions are installed and their commands exist', async () => {
  for (const id of ['anthropic.claude-code', 'openai.chatgpt']) {
    const ext = vscode.extensions.getExtension(id);
    assert.ok(ext, `${id} is installed`);
    console.log(`    ${id} ${ext.packageJSON.version}`);
  }
  await new Promise(r => setTimeout(r, 3000)); // let them activate
  const commands = new Set(await vscode.commands.getCommands(true));
  for (const id of ['claude-vscode.insertAtMention', 'claude-vscode.focus', 'chatgpt.addFileToThread', 'chatgpt.openSidebar']) {
    assert.ok(commands.has(id), id);
  }
});

test('Add to Claude Chat opens the file, then hands it to Claude Code', async () => {
  const before = webviewTabs().length;
  await vscode.commands.executeCommand('multiRepoExplorer.addTo.claude', fileNode('services/api-gateway/README.md'));
  const opened = vscode.window.tabGroups.all.flatMap(g => g.tabs).map(t => t.input);
  assert.ok(
    opened.some(i => i instanceof vscode.TabInputText && i.uri.fsPath === at('services/api-gateway/README.md')),
    'the file was opened for Claude Code to mention',
  );
  const tabs = await waitFor('a Claude Code tab', () => webviewTabs().length > before && webviewTabs());
  console.log(`    webview tabs: ${tabs.join(', ')}`);
});

test('Add to Claude Chat with two files handles both', async () => {
  const files = [fileNode('services/api-gateway/src/index.ts'), fileNode('services/api-gateway/src/routes.ts')];
  await vscode.commands.executeCommand('multiRepoExplorer.addTo.claude', files[0], files);
  const open = vscode.window.tabGroups.all.flatMap(g => g.tabs).map(t => t.input);
  const lastFile = open.find(i => i instanceof vscode.TabInputText && i.uri.fsPath === files[1].uri.fsPath);
  assert.ok(lastFile, 'the second file was opened too');
});

test('Add to Codex Chat runs without opening the file', async () => {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('multiRepoExplorer.addTo.codex', fileNode('services/billing/README.md'));
  const editors = vscode.window.tabGroups.all.flatMap(g => g.tabs).map(t => t.input);
  assert.ok(
    !editors.some(i => i instanceof vscode.TabInputText && i.uri.fsPath === at('services/billing/README.md')),
    'Codex takes the file without opening it',
  );
});

test('Copy to AI Chat copies @path mentions for folders and files', async () => {
  await vscode.commands.executeCommand('multiRepoExplorer.copyToAiChat', dirNode('services/api-gateway'));
  assert.equal(await vscode.env.clipboard.readText(), '@services/api-gateway/');
  await vscode.commands.executeCommand('multiRepoExplorer.copyToAiChat', fileNode('services/billing/README.md'));
  assert.equal(await vscode.env.clipboard.readText(), '@services/billing/README.md');
  await vscode.commands.executeCommand('multiRepoExplorer.copyToAiChat', dirNode('services/auth-service'), [
    dirNode('services/auth-service'),
    dirNode('frontend/web-app'),
  ]);
  assert.equal(await vscode.env.clipboard.readText(), '@services/auth-service/ @frontend/web-app/');
});

export async function run(): Promise<void> {
  await vscode.extensions.getExtension<MultiRepoExplorerApi>('prateep-r.multi-repo-explorer')!.activate();
  const clipboard = await vscode.env.clipboard.readText();
  let failed = 0;
  try {
    for (const [name, fn] of tests) {
      try {
        await fn();
        console.log(`  ✔ ${name}`);
      } catch (error) {
        failed++;
        console.log(`  ✘ ${name}\n    ${error instanceof Error ? error.message : error}`);
      }
    }
  } finally {
    await vscode.env.clipboard.writeText(clipboard);
  }
  if (failed) throw new Error(`${failed} of ${tests.length} chat tests failed`);
  console.log(`  ${tests.length} chat tests passed`);
}
