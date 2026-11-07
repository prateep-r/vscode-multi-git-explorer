// Integration tests of handing files to AI chats, with stand-ins for the
// Claude Code and Codex commands. The chat suite (chatSuite.ts) checks the
// same with the real extensions installed.
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { ExplorerNode } from '../views/repoExplorer';
import type { ReposNode } from '../views/reposView';
import { at, stub, test } from './harness';

const CHATS = { claude: 'anthropic.claude-code', codex: 'openai.chatgpt' };

/** Runs `fn` with the given chat extensions installed, their commands recorded, and failing where asked. */
async function withChats(
  installed: (keyof typeof CHATS)[],
  fn: (calls: string[], info: string[]) => Promise<void>,
  failing: string[] = [],
): Promise<void> {
  const calls: string[] = [];
  const info: string[] = [];
  const commands = ['claude-vscode.insertAtMention', 'claude-vscode.focus', 'chatgpt.addFileToThread', 'chatgpt.openSidebar'].map(id =>
    vscode.commands.registerCommand(id, (uri?: vscode.Uri) => {
      // Claude Code mentions the active editor's file; the others are given theirs.
      const file = id === 'claude-vscode.insertAtMention' ? vscode.window.activeTextEditor?.document.uri : uri;
      calls.push(`${id} ${file ? vscode.workspace.asRelativePath(file) : ''}`.trim());
      if (failing.includes(id)) throw new Error('refused');
    }),
  );
  const ids = new Set(installed.map(k => CHATS[k]));
  const getExtension = vscode.extensions.getExtension;
  const restore = [
    stub(vscode.extensions, 'getExtension', ((id: string) => (ids.has(id) ? { id } : getExtension(id))) as never),
    stub(vscode.window, 'showInformationMessage', (async (text: string) => void info.push(text)) as never),
  ];
  const clipboard = await vscode.env.clipboard.readText();
  try {
    await fn(calls, info);
  } finally {
    restore.forEach(r => r());
    commands.forEach(c => c.dispose());
    await vscode.env.clipboard.writeText(clipboard);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }
}

const file = (rel: string): ExplorerNode => ({ uri: vscode.Uri.file(at(rel)), isDir: false });
const folder = (rel: string): ExplorerNode => ({ uri: vscode.Uri.file(at(rel)), isDir: true });
const paste = process.platform === 'darwin' ? 'Cmd+V' : 'Ctrl+V';

export function registerChatTargetTests(): void {
  test('Add to Claude and Codex Chat add files, and copy folders and refused files as @mentions', () =>
    withChats(['claude', 'codex'], async (calls, info) => {
      await vscode.commands.executeCommand('multiGitExplorer.addTo.claude', file('docs/README.md'), [file('docs/README.md'), folder('docs')]);
      assert.deepEqual(calls, ['claude-vscode.insertAtMention docs/README.md', 'claude-vscode.focus']);
      assert.equal(await vscode.env.clipboard.readText(), '@docs/');
      assert.deepEqual(info, [`Copied @docs/ — press ${paste} in the Claude chat to add it.`]);

      calls.length = 0;
      await vscode.commands.executeCommand('multiGitExplorer.addTo.codex', file('docs/README.md'));
      assert.deepEqual(calls, ['chatgpt.addFileToThread docs/README.md'], 'a file alone needs no copying');
    }));

  test('a file the chat refuses is copied instead, and a chat that fails to open still gets the message', () =>
    withChats(
      ['codex'],
      async (calls, info) => {
        await vscode.commands.executeCommand('multiGitExplorer.addTo.codex', file('docs/README.md'));
        assert.deepEqual(calls, ['chatgpt.addFileToThread docs/README.md', 'chatgpt.openSidebar']);
        assert.equal(await vscode.env.clipboard.readText(), '@docs/README.md');
        assert.match(info[0], /in the Codex chat/);
      },
      ['chatgpt.addFileToThread', 'chatgpt.openSidebar'],
    ));

  test('Copy to AI Chat copies @mentions, and opens the chat only when one is installed', async () => {
    const repoRow: ReposNode = { type: 'repo', root: at('services/search') };
    const group: ReposNode = { type: 'group', key: 'clean' };
    await withChats(['claude'], async (calls, info) => {
      await vscode.commands.executeCommand('multiGitExplorer.copyToAiChat', repoRow, [repoRow, group, file('docs/README.md')]);
      assert.equal(await vscode.env.clipboard.readText(), '@services/search/ @docs/README.md');
      assert.deepEqual(calls, ['claude-vscode.focus'], 'the only chat installed');
      assert.match(info[0], /in the Claude chat/);
    });
    await withChats(['claude', 'codex'], async (calls, info) => {
      await vscode.commands.executeCommand('multiGitExplorer.copyToAiChat', file('docs/README.md'));
      assert.deepEqual(calls, [], 'two chats: the user picks');
      assert.match(info[0], /in your AI chat/);
    });
    await withChats([], async (calls, info) => {
      await vscode.commands.executeCommand('multiGitExplorer.copyToAiChat', group);
      assert.deepEqual(info, [], 'nothing to copy');
    });
  });
}
