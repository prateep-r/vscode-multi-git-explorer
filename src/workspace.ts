import * as path from 'path';
import * as vscode from 'vscode';

/** The git executable from VS Code's `git.path` setting, or undefined to use the one on PATH. */
export function gitPath(): string | undefined {
  const value = vscode.workspace.getConfiguration('git').get<string | string[]>('path');
  return (Array.isArray(value) ? value[0] : value) || undefined;
}

/** Workspace folders on the local disk. Remote and virtual folders aren't supported. */
export function localFolders(): readonly vscode.WorkspaceFolder[] {
  return (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file');
}

/** Whether a path is one of the workspace folders, which the tree shows as its top-level rows. */
export function isWorkspaceFolder(fsPath: string): boolean {
  return localFolders().some(f => f.uri.fsPath === fsPath);
}

/** Whether the workspace has more than one folder, so paths need the folder name to be clear. */
export function isMultiRoot(): boolean {
  return localFolders().length > 1;
}

/** The folder a row stands for: itself, or the folder a file is in. */
export function folderOf(row: { uri: vscode.Uri; isDir: boolean }): vscode.Uri {
  return row.isDir ? row.uri : vscode.Uri.file(path.dirname(row.uri.fsPath));
}

/** Whether a row's file is on disk: rows of deleted files, listed while filtering, are not. */
export function onDisk(row: { change?: { letter: string } }): boolean {
  return row.change?.letter !== 'D';
}

/**
 * The rows a command applies to: every selected row when the clicked one is
 * part of the selection, like the built-in Explorer. Keyboard shortcuts pass
 * no row, so they act on the selection.
 */
export function pickRows<T>(clicked: T | undefined, selected: readonly T[] | undefined, key: (row: T) => string): T[] {
  if (clicked === undefined) return [...(selected ?? [])];
  const all = selected ?? [];
  return all.some(row => key(row) === key(clicked)) ? [...all] : [clicked];
}

/**
 * Keyboard shortcuts pass `{ "keyboard": true }` (their `args` in
 * package.json), so commands know to act on the focused row, as the built-in
 * Explorer's shortcuts do, rather than on a clicked one.
 */
export function isKeyboard(arg: unknown): arg is { keyboard: true } {
  return typeof arg === 'object' && arg !== null && (arg as { keyboard?: unknown }).keyboard === true;
}
