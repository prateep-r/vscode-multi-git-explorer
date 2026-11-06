import * as vscode from 'vscode';

/**
 * Rows in our own views use this scheme instead of `file:`. VS Code decorates
 * by URI, so this keeps our badges out of the built-in Explorer (and keeps
 * VS Code's own git letters, which only cover repos it has opened, out of our
 * views) while file icons still come from the icon theme.
 */
export const VIEW_SCHEME = 'multi-git-explorer';

export function toViewUri(fsPath: string): vscode.Uri {
  return vscode.Uri.file(fsPath).with({ scheme: VIEW_SCHEME });
}
