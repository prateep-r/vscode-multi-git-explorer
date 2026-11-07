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

/**
 * Rows of the Git Repositories view carry this query, so the built-in
 * Explorer's decoration settings, which the file tree follows, leave them alone.
 */
const REPOS_VIEW_QUERY = 'repos';

export function toReposViewUri(fsPath: string): vscode.Uri {
  return toViewUri(fsPath).with({ query: REPOS_VIEW_QUERY });
}

/** Whether a URI is a row of the file tree, not of the Git Repositories view. */
export function isFilesTreeUri(uri: vscode.Uri): boolean {
  return uri.scheme === VIEW_SCHEME && uri.query !== REPOS_VIEW_QUERY;
}

/** Whether a configuration change touches `explorer.decorations.colors` or `.badges`. */
export function affectsExplorerDecorations(e: vscode.ConfigurationChangeEvent): boolean {
  return e.affectsConfiguration('explorer.decorations');
}

/**
 * A decoration as the file tree shows it: without its color when
 * `explorer.decorations.colors` is off, and without its badge when
 * `explorer.decorations.badges` is off, as in the built-in Explorer.
 */
export function asFilesTreeShows(uri: vscode.Uri, decoration: vscode.FileDecoration | undefined): vscode.FileDecoration | undefined {
  if (!decoration || !isFilesTreeUri(uri)) return decoration;
  const config = vscode.workspace.getConfiguration('explorer.decorations');
  const colors = config.get<boolean>('colors') !== false;
  const badges = config.get<boolean>('badges') !== false;
  if (colors && badges) return decoration;
  const color = colors ? decoration.color : undefined;
  const badge = badges ? decoration.badge : undefined;
  if (!color && !badge) return undefined;
  const shown = new vscode.FileDecoration(badge, decoration.tooltip, color);
  shown.propagate = decoration.propagate;
  return shown;
}
