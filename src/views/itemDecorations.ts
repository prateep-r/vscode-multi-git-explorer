import * as vscode from 'vscode';
import type { RepoExplorerProvider } from './repoExplorer';
import { affectsExplorerDecorations, asFilesTreeShows, isFilesTreeUri } from './viewUri';

/**
 * The marks the built-in Explorer puts on rows by itself: `⤷` on symbolic
 * links, `?` on unknown file types, `!` on workspace folders that can't be
 * read, and a dimmed name for items `files.exclude` hides that are shown
 * because an editor has them open. Same badges, tooltips and colors.
 */
export class ItemDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;
  private readonly disposables: vscode.Disposable[];

  constructor(private readonly explorer: RepoExplorerProvider) {
    this.disposables = [
      this._onDidChange,
      explorer.onDidChangeMarks(uris => this._onDidChange.fire(uris)),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (affectsExplorerDecorations(e)) this._onDidChange.fire(undefined);
      }),
    ];
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (!isFilesTreeUri(uri)) return undefined;
    const mark = this.explorer.markOf(uri.fsPath);
    let decoration: vscode.FileDecoration | undefined;
    if (typeof mark === 'object') {
      decoration = new vscode.FileDecoration('!', `Unable to resolve workspace folder (${mark.rootError})`, new vscode.ThemeColor('list.invalidItemForeground'));
    } else if (mark === 'symlink') {
      decoration = new vscode.FileDecoration('⤷', 'Symbolic Link');
    } else if (mark === 'unknown') {
      decoration = new vscode.FileDecoration('?', 'Unknown File Type');
    } else if (mark === 'excluded') {
      decoration = new vscode.FileDecoration(undefined, undefined, new vscode.ThemeColor('list.deemphasizedForeground'));
    }
    return asFilesTreeShows(uri, decoration);
  }
}
