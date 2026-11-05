import * as path from 'path';
import * as vscode from 'vscode';
import type { GroupKey } from '../core/state';
import type { RepoEntry, RepoStore } from '../store';

export interface ExplorerNode {
  uri: vscode.Uri;
  isDir: boolean;
}

/** Group symbols used in a parent folder's summary, most serious first. */
const SUMMARY_SYMBOLS: [GroupKey[], string][] = [
  [['conflict', 'error'], '!'],
  [['dirty'], '●'],
  [['unpushed'], '↑'],
  [['behind'], '↓'],
  [['checking'], '…'],
];

/**
 * A file tree like the built-in Explorer, but with each repo's branch and
 * state written after its name. The built-in Explorer cannot show that text:
 * extensions may only add a color and a two-character badge there.
 */
export class RepoExplorerProvider implements vscode.TreeDataProvider<ExplorerNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<ExplorerNode | ExplorerNode[] | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  /** Folder nodes handed out so far, so updates can target them. */
  private readonly dirNodes = new Map<string, ExplorerNode>();
  private readonly disposables: vscode.Disposable[];

  constructor(private readonly store: RepoStore) {
    this.disposables = [
      store.onDidChangeRepos(roots => this.onReposChanged(roots)),
      store.onDidDiscover(() => this._onDidChangeTreeData.fire(undefined)),
      store.onDidChangeFolder(dir => this.onFolderChanged(dir)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this._onDidChangeTreeData.fire(undefined)),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('files.exclude')) this._onDidChangeTreeData.fire(undefined);
      }),
      this._onDidChangeTreeData,
    ];
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }

  async getChildren(node?: ExplorerNode): Promise<ExplorerNode[]> {
    if (!node) {
      const folders = (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file');
      if (folders.length === 1) return this.readDir(folders[0].uri);
      return folders.map(f => this.dirNode(f.uri));
    }
    return this.readDir(node.uri);
  }

  getParent(node: ExplorerNode): ExplorerNode | undefined {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.some(f => f.uri.fsPath === node.uri.fsPath)) return undefined;
    const parent = vscode.Uri.file(path.dirname(node.uri.fsPath));
    if (folders.length === 1 && folders[0].uri.fsPath === parent.fsPath) return undefined;
    return this.dirNode(parent);
  }

  getTreeItem(node: ExplorerNode): vscode.TreeItem {
    if (!node.isDir) {
      const item = new vscode.TreeItem(node.uri, vscode.TreeItemCollapsibleState.None);
      item.command = { command: 'vscode.open', title: 'Open', arguments: [node.uri] };
      item.contextValue = 'file';
      return item;
    }

    const item = new vscode.TreeItem(node.uri, vscode.TreeItemCollapsibleState.Collapsed);
    const fsPath = node.uri.fsPath;
    const repo = this.store.get(fsPath);
    if (repo) {
      item.description = repo.view.description;
      item.tooltip = repo.view.tooltip;
      item.contextValue = repo.view.contextValue;
      return item;
    }

    item.contextValue = 'folder';
    if (this.store.repoContaining(fsPath)) return item;

    const below = this.store.reposUnder(fsPath);
    if (below.length > 0) {
      item.description = summarize(below);
    } else if (this.store.isScanned(fsPath)) {
      item.description = 'no git';
    } else if (this.isExcluded(fsPath)) {
      item.description = 'excluded';
    } else {
      item.description = 'not scanned';
      item.tooltip = 'Past the scan depth limit. Right-click to scan this folder.';
      item.contextValue = 'folder unscanned';
    }
    return item;
  }

  private async readDir(uri: vscode.Uri): Promise<ExplorerNode[]> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(uri);
    } catch {
      return [];
    }
    const hidden = this.hiddenNames(uri);
    return entries
      .filter(([name]) => !hidden.has(name))
      .map(([name, type]) => ({ name, isDir: (type & vscode.FileType.Directory) !== 0 }))
      .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, undefined, { numeric: true }))
      .map(({ name, isDir }) => {
        const child = vscode.Uri.joinPath(uri, name);
        return isDir ? this.dirNode(child) : { uri: child, isDir: false };
      });
  }

  private dirNode(uri: vscode.Uri): ExplorerNode {
    let node = this.dirNodes.get(uri.fsPath);
    if (!node) {
      node = { uri, isDir: true };
      this.dirNodes.set(uri.fsPath, node);
    }
    return node;
  }

  /** Names hidden by `files.exclude` patterns of the simple `**\/name` form. */
  private hiddenNames(uri: vscode.Uri): Set<string> {
    const patterns = vscode.workspace.getConfiguration('files', uri).get<Record<string, boolean>>('exclude', {});
    const names = new Set(['.git']);
    for (const [pattern, enabled] of Object.entries(patterns)) {
      const match = /^\*\*\/([^/*?[\]{}]+)$/.exec(pattern);
      if (enabled && match) names.add(match[1]);
    }
    return names;
  }

  private isExcluded(fsPath: string): boolean {
    const exclude = vscode.workspace.getConfiguration('multiRepoGit').get<string[]>('exclude', []);
    const name = path.basename(fsPath);
    return name.startsWith('.') || exclude.includes(name);
  }

  private onReposChanged(roots: string[]): void {
    // The repo's own row, plus every folder above it whose summary includes it.
    const changed = new Set<ExplorerNode>();
    for (const root of roots) {
      for (let dir = root; ; dir = path.dirname(dir)) {
        const node = this.dirNodes.get(dir);
        if (node) changed.add(node);
        if (path.dirname(dir) === dir) break;
      }
    }
    if (changed.size) this._onDidChangeTreeData.fire([...changed]);
  }

  private onFolderChanged(dir: string): void {
    const node = this.dirNodes.get(dir);
    const isTopLevel = (vscode.workspace.workspaceFolders ?? []).some(f => f.uri.fsPath === dir);
    if (node && !isTopLevel) this._onDidChangeTreeData.fire(node);
    else if (isTopLevel) this._onDidChangeTreeData.fire(undefined);
  }
}

function summarize(repos: RepoEntry[]): string {
  const parts = [`${repos.length} ${repos.length === 1 ? 'repo' : 'repos'}`];
  const counts = SUMMARY_SYMBOLS.map(
    ([groups, symbol]) => [symbol, repos.filter(r => groups.includes(r.view.group)).length] as const,
  ).filter(([, n]) => n > 0);
  parts.push(counts.length ? counts.map(([symbol, n]) => `${symbol}${n}`).join(' ') : 'all clean');
  return parts.join(' · ');
}
