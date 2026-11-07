import * as path from 'path';
import * as vscode from 'vscode';
import { repoRelative } from '../core/paths';
import type { RepoStore } from '../store';
import { headUri } from './headContent';
import type { ExplorerNode } from './repoExplorer';

const DIFF_LABELS: Record<string, string> = {
  M: 'Working Tree',
  R: 'Renamed',
  A: 'Added',
  U: 'Untracked',
  D: 'Deleted',
};

/**
 * What opening a changed file runs: a diff against HEAD, or the file itself
 * when it's conflicted, so it can be resolved. It's `vscode.diff` or
 * `vscode.open` without options so that, as a row's command, VS Code passes
 * on how the row was opened, like the built-in Explorer: a click opens a
 * preview, a double-click keeps the editor open, and
 * `workbench.list.openMode` is followed.
 */
export function changeCommand(store: RepoStore, node: ExplorerNode): vscode.Command {
  const repo = store.repoContaining(node.uri.fsPath);
  const change = node.change;
  if (!repo || !change || change.letter === '!') return { command: 'vscode.open', title: 'Open', arguments: [node.uri] };
  const relPath = repoRelative(repo.root, node.uri.fsPath);
  // A file inside an untracked folder carries the folder's change, so it's new too.
  const isNew = change.letter === 'A' || change.letter === 'U';
  const left = headUri(node.uri, repo.root, isNew ? undefined : (change.origPath ?? relPath));
  const right = change.letter === 'D' ? headUri(node.uri, repo.root, undefined) : node.uri;
  const title = `${path.basename(node.uri.fsPath)} (${DIFF_LABELS[change.letter]})`;
  return { command: 'vscode.diff', title: 'Open Changes', arguments: [left, right, title] };
}

/** Shows a changed file as a diff against HEAD; conflicted files open as-is so they can be resolved. */
export async function openChange(store: RepoStore, node: ExplorerNode, options?: vscode.TextDocumentShowOptions): Promise<void> {
  const { command, arguments: args = [] } = changeCommand(store, node);
  if (command === 'vscode.diff') await vscode.commands.executeCommand(command, ...args, { preview: true, ...options });
  else await vscode.commands.executeCommand(command, ...args, options);
}
