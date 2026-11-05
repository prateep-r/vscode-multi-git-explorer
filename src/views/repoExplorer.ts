import * as path from 'path';
import * as vscode from 'vscode';
import { FILTER_LABELS, describeChange, filteredEntries, matchesFilter, type ExplorerFilter } from '../core/filter';
import type { ChangedFile } from '../core/porcelain';
import type { GroupKey } from '../core/state';
import type { RepoEntry, RepoStore } from '../store';
import { toViewUri } from './viewUri';

export interface ExplorerNode {
  uri: vscode.Uri;
  isDir: boolean;
  /** For a changed file (or untracked folder) listed while filtering. */
  change?: ChangedFile;
}

/** Group symbols used in a parent folder's summary, most serious first. */
const SUMMARY_SYMBOLS: [GroupKey[], string][] = [
  [['conflict', 'error'], '!'],
  [['dirty'], '●'],
  [['unpushed'], '↑'],
  [['behind'], '↓'],
  [['checking'], '…'],
];

const FILTER_STATE_KEY = 'multiRepoGit.explorerFilter';
const FILTER_ORDER: ExplorerFilter[] = ['changes', 'unpushed', 'behind'];
const FILTERED_REFRESH_MS = 300;

/**
 * A file tree like the built-in Explorer, but with each repo's branch and
 * state written after its name. The built-in Explorer cannot show that text:
 * extensions may only add a color and a two-character badge there.
 *
 * It can be filtered down to the repos that match, showing only their
 * changed files.
 */
export class RepoExplorerProvider implements vscode.TreeDataProvider<ExplorerNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<ExplorerNode | ExplorerNode[] | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  /** Folder nodes handed out so far, so updates can target them. */
  private readonly dirNodes = new Map<string, ExplorerNode>();
  private filters: Set<ExplorerFilter>;
  private treeView?: vscode.TreeView<ExplorerNode>;
  private refreshTimer?: NodeJS.Timeout;
  private readonly disposables: vscode.Disposable[];

  constructor(
    private readonly store: RepoStore,
    private readonly state: vscode.Memento,
  ) {
    this.filters = new Set(state.get<ExplorerFilter[]>(FILTER_STATE_KEY, []));
    this.disposables = [
      store.onDidChangeRepos(roots => this.onReposChanged(roots)),
      store.onDidDiscover(() => this.refreshAll()),
      store.onDidChangeFolder(dir => this.onFolderChanged(dir)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refreshAll()),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('files.exclude')) this.refreshAll();
      }),
      this._onDidChangeTreeData,
    ];
    this.updateContextKeys();
  }

  dispose(): void {
    clearTimeout(this.refreshTimer);
    this.disposables.forEach(d => d.dispose());
  }

  attach(treeView: vscode.TreeView<ExplorerNode>): void {
    this.treeView = treeView;
    this.updateMessage();
  }

  get activeFilters(): ExplorerFilter[] {
    return FILTER_ORDER.filter(f => this.filters.has(f));
  }

  setFilters(filters: ExplorerFilter[]): void {
    this.filters = new Set(filters);
    void this.state.update(FILTER_STATE_KEY, this.activeFilters);
    this.updateContextKeys();
    this.refreshAll();
  }

  toggleFilter(filter: ExplorerFilter): void {
    const next = new Set(this.filters);
    if (next.has(filter)) next.delete(filter);
    else next.add(filter);
    this.setFilters([...next]);
  }

  /** Drive which title-bar buttons show as on (`multiRepoGit.filter.<name>`). */
  private updateContextKeys(): void {
    void vscode.commands.executeCommand('setContext', 'multiRepoGit.explorerFiltered', this.filtering);
    for (const filter of FILTER_ORDER) {
      void vscode.commands.executeCommand('setContext', `multiRepoGit.filter.${filter}`, this.filters.has(filter));
    }
  }

  private get filtering(): boolean {
    return this.filters.size > 0;
  }

  async getChildren(node?: ExplorerNode): Promise<ExplorerNode[]> {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file');
    if (!node && folders.length !== 1) {
      const nodes = folders.map(f => this.dirNode(f.uri));
      return this.filtering ? nodes.filter(n => this.matchingRepos().some(r => isAtOrBelow(r.root, n.uri.fsPath))) : nodes;
    }
    const uri = node?.uri ?? folders[0]?.uri;
    if (!uri) return [];
    if (!this.filtering) return this.readDir(uri);
    if (node?.change) {
      // An untracked folder is new as a whole, so everything inside it is a change.
      return (await this.readDir(uri)).map(child => ({ ...child, change: node.change }));
    }
    return this.filteredChildren(uri);
  }

  getParent(node: ExplorerNode): ExplorerNode | undefined {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.some(f => f.uri.fsPath === node.uri.fsPath)) return undefined;
    const parent = vscode.Uri.file(path.dirname(node.uri.fsPath));
    if (folders.length === 1 && folders[0].uri.fsPath === parent.fsPath) return undefined;
    return this.dirNode(parent);
  }

  getTreeItem(node: ExplorerNode): vscode.TreeItem {
    const fsPath = node.uri.fsPath;
    // Separate ids per mode, so filtered folders open expanded without
    // changing what the user expanded in the unfiltered tree.
    const id = `${this.filtering ? `f:${this.activeFilters.join(',')}` : 'all'}:${fsPath}`;

    if (!node.isDir) {
      const item = new vscode.TreeItem(toViewUri(fsPath), vscode.TreeItemCollapsibleState.None);
      item.id = id;
      item.contextValue = 'file';
      if (node.change?.letter !== 'D') item.command = { command: 'vscode.open', title: 'Open', arguments: [node.uri] };
      if (node.change) item.description = describeChange(node.change);
      return item;
    }

    const expanded = this.filtering && !node.change;
    const item = new vscode.TreeItem(
      toViewUri(fsPath),
      expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.id = id;
    const repo = this.store.get(fsPath);
    if (repo) {
      item.description = repo.view.description;
      item.tooltip = repo.view.tooltip;
      item.contextValue = repo.view.contextValue;
      if (this.filtering && !this.showsFilesOf(repo) && !this.matchingRepos().some(r => isBelow(r.root, fsPath))) {
        item.collapsibleState = vscode.TreeItemCollapsibleState.None;
      }
      return item;
    }

    item.contextValue = 'folder';
    if (node.change) item.description = 'untracked';
    if (this.store.repoContaining(fsPath)) return item;

    const below = this.filtering ? this.matchingRepos().filter(r => isBelow(r.root, fsPath)) : this.store.reposUnder(fsPath);
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

  private matchingRepos(): RepoEntry[] {
    return this.store.all().filter(r => matchesFilter(r.status, this.filters, r.cheap?.hasRemote));
  }

  /** Whether a repo's changed files are listed under it while filtering. */
  private showsFilesOf(repo: RepoEntry): boolean {
    return this.filters.has('changes') && (repo.status?.changedFiles ?? 0) > 0;
  }

  private filteredChildren(uri: vscode.Uri): ExplorerNode[] {
    const matching = this.matchingRepos();
    const changes = matching.filter(r => this.showsFilesOf(r)).map(r => ({ root: r.root, files: r.status!.files }));
    return filteredEntries(
      uri.fsPath,
      matching.map(r => r.root),
      changes,
    ).map(entry => {
      const child = vscode.Uri.joinPath(uri, entry.name);
      if (!entry.isDir) return { uri: child, isDir: false, change: entry.change };
      return entry.change ? { uri: child, isDir: true, change: entry.change } : this.dirNode(child);
    });
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

  private refreshAll(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    this._onDidChangeTreeData.fire(undefined);
    this.updateMessage();
  }

  private onReposChanged(roots: string[]): void {
    if (this.filtering) {
      // Which repos and files match may have changed, so rebuild, but not on every single check.
      this.refreshTimer ??= setTimeout(() => this.refreshAll(), FILTERED_REFRESH_MS);
      return;
    }
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
    if (this.filtering) return;
    const node = this.dirNodes.get(dir);
    const isTopLevel = (vscode.workspace.workspaceFolders ?? []).some(f => f.uri.fsPath === dir);
    if (node && !isTopLevel) this._onDidChangeTreeData.fire(node);
    else if (isTopLevel) this._onDidChangeTreeData.fire(undefined);
  }

  private updateMessage(): void {
    if (!this.treeView) return;
    if (!this.filtering) {
      this.treeView.message = undefined;
      return;
    }
    const shown = this.matchingRepos().length;
    const labels = this.activeFilters.map(f => FILTER_LABELS[f].toLowerCase()).join(', ');
    this.treeView.message =
      shown === 0
        ? `No repos match the filter (${labels}).`
        : `Showing ${labels} · ${shown} of ${this.store.all().length} repos`;
  }
}

function isBelow(fsPath: string, dir: string): boolean {
  return fsPath.startsWith(dir + path.sep);
}

function isAtOrBelow(fsPath: string, dir: string): boolean {
  return fsPath === dir || isBelow(fsPath, dir);
}

function summarize(repos: RepoEntry[]): string {
  const parts = [`${repos.length} ${repos.length === 1 ? 'repo' : 'repos'}`];
  const counts = SUMMARY_SYMBOLS.map(
    ([groups, symbol]) => [symbol, repos.filter(r => groups.includes(r.view.group)).length] as const,
  ).filter(([, n]) => n > 0);
  parts.push(counts.length ? counts.map(([symbol, n]) => `${symbol}${n}`).join(' ') : 'all clean');
  return parts.join(' · ');
}
