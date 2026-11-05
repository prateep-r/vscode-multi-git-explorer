import * as vscode from 'vscode';
import { formatMentions } from './core/mention';
import type { ExplorerNode } from './views/repoExplorer';
import type { ReposNode } from './views/reposView';

/**
 * AI chat extensions we can hand files to. Each only exposes a command that
 * works on files, so files are added for real and folders are copied as
 * `@path/` for the user to paste.
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

/** The rows a command applies to: every selected row when the clicked one is part of the selection. */
function pickedRows(clicked: Row | undefined, selected: readonly Row[] | undefined): Picked[] {
  const toPicked = (row: Row): Picked[] => {
    if ('uri' in row) return [{ uri: row.uri, isDir: row.isDir }];
    if (row.type === 'repo') return [{ uri: vscode.Uri.file(row.root), isDir: true }];
    return [];
  };
  const target = clicked ? toPicked(clicked) : [];
  const all = (selected ?? []).flatMap(toPicked);
  // Right-clicking outside the selection acts on the clicked row only, like the built-in Explorer.
  return target.length && all.some(p => p.uri.fsPath === target[0].uri.fsPath) ? all : target;
}

async function copyMentions(target: ChatTarget, rows: Picked[]): Promise<void> {
  const text = formatMentions(rows.map(r => ({ path: vscode.workspace.asRelativePath(r.uri), isDir: r.isDir })));
  await vscode.env.clipboard.writeText(text);
  await Promise.resolve(target.focus()).catch(() => undefined);
  const paste = process.platform === 'darwin' ? 'Cmd+V' : 'Ctrl+V';
  void vscode.window.showInformationMessage(`Copied ${text} — press ${paste} in the ${target.name} chat to add it.`);
}

export function registerChatTargets(): vscode.Disposable[] {
  const updateAvailability = () => {
    for (const target of TARGETS) {
      const installed = vscode.extensions.getExtension(target.extensionId) !== undefined;
      void vscode.commands.executeCommand('setContext', `multiRepoExplorer.has.${target.key}`, installed);
    }
  };
  updateAvailability();

  return [
    vscode.extensions.onDidChange(updateAvailability),
    ...TARGETS.flatMap(target => [
      vscode.commands.registerCommand(`multiRepoExplorer.addTo.${target.key}`, async (clicked?: Row, selected?: Row[]) => {
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
        if (folders.length || failed.length) await copyMentions(target, [...failed, ...folders]);
      }),
      vscode.commands.registerCommand(`multiRepoExplorer.copyTo.${target.key}`, (clicked?: Row, selected?: Row[]) =>
        copyMentions(target, pickedRows(clicked, selected)),
      ),
    ]),
  ];
}
