import { existsSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { repoRelative, isAtOrInside } from '../core/paths';
import { autoRevealOn, isRevealExcluded } from '../core/reveal';
import { parse, type IExpression, type ParsedExpression } from '../core/vs/glob';
import { localFolders } from '../workspace';
import type { ExplorerNode, RepoExplorerProvider } from './repoExplorer';

const DEBOUNCE_MS = 100;

/**
 * Selects the active editor's file in the file tree, expanding the folders
 * above it, as the built-in Explorer does with `explorer.autoReveal`. Files
 * matching `explorer.autoRevealExclude`, or inside folders that do, are left
 * alone. Keyboard focus stays in the editor.
 */
export class AutoReveal implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[];
  private timer?: NodeJS.Timeout;
  private excludes = new Map<string, ParsedExpression>();

  constructor(
    private readonly explorer: RepoExplorerProvider,
    private readonly tree: vscode.TreeView<ExplorerNode>,
  ) {
    this.disposables = [
      vscode.window.tabGroups.onDidChangeTabs(e => {
        if ([...e.opened, ...e.changed].some(tab => tab.isActive && tab.group.isActive)) this.schedule();
      }),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.schedule()),
      tree.onDidChangeVisibility(e => {
        if (e.visible) this.schedule();
      }),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('explorer.autoRevealExclude')) this.excludes.clear();
        if (e.affectsConfiguration('explorer.autoReveal')) this.schedule();
      }),
      // After the whole tree is rebuilt, select the active file again, like the built-in Explorer.
      explorer.onDidChangeTreeData(e => {
        if (e === undefined) this.schedule();
      }),
    ];
    this.schedule();
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.disposables.forEach(d => d.dispose());
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.revealActiveFile(), DEBOUNCE_MS);
  }

  /** Reveals the active editor's file now. Returns whether it tried. */
  async revealActiveFile(): Promise<boolean> {
    if (!autoRevealOn(vscode.workspace.getConfiguration('explorer').get('autoReveal')) || !this.tree.visible) return false;
    const file = activeFile();
    if (!file) return false;
    const root = localFolders()
      .map(f => f.uri.fsPath)
      .filter(r => isAtOrInside(file.fsPath, r))
      .sort((a, b) => b.length - a.length)[0];
    if (!root || root === file.fsPath) return false;
    const selection = this.tree.selection;
    if (selection.length === 1 && selection[0].uri.fsPath === file.fsPath) return false;
    const dir = path.dirname(file.fsPath);
    if (isRevealExcluded(this.excludesFor(root), repoRelative(root, file.fsPath), name => existsSync(path.join(dir, name)))) return false;
    await this.explorer.reveal(file, false);
    return true;
  }

  private excludesFor(root: string): ParsedExpression {
    let matches = this.excludes.get(root);
    if (!matches) {
      const value = vscode.workspace.getConfiguration('explorer', vscode.Uri.file(root)).get<object>('autoRevealExclude') ?? {};
      matches = parse(JSON.parse(JSON.stringify(value)) as IExpression);
      this.excludes.set(root, matches);
    }
    return matches;
  }
}

/** The file in the active editor; for a diff, its modified side, as the built-in Explorer takes the primary side. */
function activeFile(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  let uri: vscode.Uri | undefined;
  if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputNotebook) {
    uri = input.uri;
  } else if (input instanceof vscode.TabInputTextDiff || input instanceof vscode.TabInputNotebookDiff) {
    uri = input.modified;
  }
  return uri?.scheme === 'file' ? uri : undefined;
}
