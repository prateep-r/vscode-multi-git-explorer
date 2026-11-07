import * as vscode from 'vscode';
import { formatMentions } from './core/mention';
import type { ExplorerNode } from './views/repoExplorer';
import type { ReposNode } from './views/reposView';
import { pickRows } from './workspace';

/**
 * AI chat extensions we can hand files to. Each only exposes a command that
 * works on files, so files are added for real. Anything can also be copied as
 * `@path` mentions, which most AI chats understand, for the user to paste.
 */
interface ChatTarget {
  key: string;
  name: string;
  extensionId: string;
  /** Adds one file to the chat. */
  addFile(uri: vscode.Uri): Thenable<unknown>;
  /** Opens or focuses the chat so a paste lands there. */
  focus(): Thenable<unknown>;
}

const TARGETS: ChatTarget[] = [
  {
    key: 'claude',
    name: 'Claude',
    extensionId: 'anthropic.claude-code',
    // Claude Code's command mentions the file in the active editor, so open the file first.
    addFile: async uri => {
      await vscode.window.showTextDocument(uri, { preview: true, preserveFocus: false });
      await vscode.commands.executeCommand('claude-vscode.insertAtMention');
    },
    focus: () => vscode.commands.executeCommand('claude-vscode.focus'),
  },
  {
    key: 'codex',
    name: 'Codex',
    extensionId: 'openai.chatgpt',
    addFile: uri => vscode.commands.executeCommand('chatgpt.addFileToThread', uri),
    focus: () => vscode.commands.executeCommand('chatgpt.openSidebar'),
  },
];

type Row = ExplorerNode | ReposNode;

interface Picked {
  uri: vscode.Uri;
  isDir: boolean;
}

function toPicked(row: Row): Picked[] {
  if ('uri' in row) return [{ uri: row.uri, isDir: row.isDir }];
  if (row.type === 'repo') return [{ uri: vscode.Uri.file(row.root), isDir: true }];
  return [];
}

/**
 * Copies `@path` mentions. The chat to paste into is opened when it's clear
 * which one: the one given, or the only one installed.
 */
async function copyMentions(rows: Picked[], target?: ChatTarget): Promise<void> {
  if (rows.length === 0) return;
  const text = formatMentions(rows.map(r => ({ path: vscode.workspace.asRelativePath(r.uri), isDir: r.isDir })));
  await vscode.env.clipboard.writeText(text);
  const installed = TARGETS.filter(t => vscode.extensions.getExtension(t.extensionId) !== undefined);
  const chat = target ?? (installed.length === 1 ? installed[0] : undefined);
  if (chat) await Promise.resolve(chat.focus()).catch(() => undefined);
  /* c8 ignore next -- the other system's key; the tests run on one system at a time */
  const paste = process.platform === 'darwin' ? 'Cmd+V' : 'Ctrl+V';
  void vscode.window.showInformationMessage(`Copied ${text} — press ${paste} in ${chat ? `the ${chat.name}` : 'your AI'} chat to add it.`);
}

/** Registers the chat commands. Keyboard shortcuts, which pass no row, act on the file tree's selection. */
export function registerChatTargets(tree: vscode.TreeView<ExplorerNode>): vscode.Disposable[] {
  const pickedRows = (clicked?: Row, selected?: readonly Row[]): Picked[] => {
    const rows: readonly Row[] | undefined = selected ?? (clicked ? undefined : tree.selection);
    return pickRows<Row>(clicked, rows, row => toPicked(row)[0]?.uri.fsPath ?? '').flatMap(toPicked);
  };

  const updateAvailability = () => {
    for (const target of TARGETS) {
      const installed = vscode.extensions.getExtension(target.extensionId) !== undefined;
      void vscode.commands.executeCommand('setContext', `multiGitExplorer.has.${target.key}`, installed);
    }
  };
  updateAvailability();

  return [
    vscode.extensions.onDidChange(updateAvailability),
    ...TARGETS.flatMap(target => [
      vscode.commands.registerCommand(`multiGitExplorer.addTo.${target.key}`, async (clicked?: Row, selected?: Row[]) => {
        const rows = pickedRows(clicked, selected);
        const folders = rows.filter(r => r.isDir);
        const failed: Picked[] = [];
        for (const file of rows.filter(r => !r.isDir)) {
          try {
            await target.addFile(file.uri);
          } catch {
            failed.push(file);
          }
        }
        // Folders can't be added, and files the chat refused are better copied than lost.
        if (folders.length || failed.length) await copyMentions([...failed, ...folders], target);
      }),
    ]),
    vscode.commands.registerCommand('multiGitExplorer.copyToAiChat', (clicked?: Row, selected?: Row[]) =>
      copyMentions(pickedRows(clicked, selected)),
    ),
  ];
}
