import { existsSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { FILTER_LABELS, describeChange, filteredEntries, matchesFilter, type ExplorerFilter } from '../core/filter';
import { isAtOrInside, isInside, repoRelative } from '../core/paths';
import type { ChangedFile } from '../core/porcelain';
import type { GroupKey } from '../core/state';
import { checkEntry, parseExcludes, ROOT_STATE, type ExcludeRules, type VisibilityState } from '../core/visibility';
import type { RepoEntry, RepoStore } from '../store';
import { folderOf, isWorkspaceFolder, localFolders } from '../workspace';
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

const FILTER_STATE_KEY = 'multiGitExplorer.explorerFilter';
const FILTER_ORDER: ExplorerFilter[] = ['changes', 'unpushed', 'behind'];
const FILTERED_REFRESH_MS = 300;
/**
 * Clicking a file opens it as a preview and keeps focus in the tree, like the
 * built-in Explorer, so keyboard shortcuts such as Copy and Rename act on the
 * row instead of the editor.
 */
const CLICK_OPEN: vscode.TextDocumentShowOptions = { preview: true, preserveFocus: true };

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
  /** Folders past the depth limit that were searched because they were opened. */
  private readonly autoScanned = new Set<string>();
  private filters: Set<ExplorerFilter>;
  private treeView?: vscode.TreeView<ExplorerNode>;
  private refreshTimer?: NodeJS.Timeout;
  private readonly disposables: vscode.Disposable[];
  /** `files.exclude` of each workspace folder, parsed. */
  private readonly excludeRules = new Map<string, ExcludeRules>();
  /** How `files.exclude` judged each item listed so far, which its children build on. */
  private readonly visibility = new Map<string, VisibilityState>();
  /** Files in the visible editors, which keep excluded items above them shown. */
  private visibleEditors = new Set<string>();
  /** Visible editors that keep an excluded item shown. */
  private readonly editorsShowingExcluded = new Set<string>();

  constructor(
    private readonly store: RepoStore,
    private readonly state: vscode.Memento,
  ) {
    this.filters = new Set(state.get<ExplorerFilter[]>(FILTER_STATE_KEY, []));
    this.disposables = [
      store.onDidChangeRepos(roots => this.onReposChanged(roots)),
      store.onDidDiscover(() => this.refreshAll()),
      store.onDidChangeFolder(dir => this.onFolderChanged(dir)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.updateTitle();
        this.refreshAll();
      }),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('files.exclude')) {
          this.excludeRules.clear();
          this.refreshAll();
        }
      }),
      vscode.window.tabGroups.onDidChangeTabs(() => this.onVisibleEditorsChanged()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.onVisibleEditorsChanged()),
      this._onDidChangeTreeData,
    ];
    this.updateContextKeys();
    this.visibleEditors = visibleEditorFiles();
  }

  dispose(): void {
    clearTimeout(this.refreshTimer);
    this.disposables.forEach(d => d.dispose());
  }

  attach(treeView: vscode.TreeView<ExplorerNode>): void {
    this.treeView = treeView;
    this.updateMessage();
    this.updateTitle();
  }

  get title(): string | undefined {
    return this.treeView?.title;
  }

  get description(): string | undefined {
    return this.treeView?.description;
  }

  /**
   * Shows the project's name beside the "Files" title. VS Code changes the
   * case of view titles (only its own Explorer keeps the case), but not of
   * descriptions, so the name is the description.
   */
  private updateTitle(): void {
    if (!this.treeView) return;
    this.treeView.title = 'Files';
    this.treeView.description = vscode.workspace.name;
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

  /** Drive which title-bar buttons show as on (`multiGitExplorer.filter.<name>`). */
  private updateContextKeys(): void {
    void vscode.commands.executeCommand('setContext', 'multiGitExplorer.explorerFiltered', this.filtering);
    for (const filter of FILTER_ORDER) {
      void vscode.commands.executeCommand('setContext', `multiGitExplorer.filter.${filter}`, this.filters.has(filter));
    }
  }

  private get filtering(): boolean {
    return this.filters.size > 0;
  }

  async getChildren(node?: ExplorerNode): Promise<ExplorerNode[]> {
    const folders = localFolders();
    if (!node && folders.length !== 1) {
      const nodes = folders.map(f => this.dirNode(f.uri));
      return this.filtering ? nodes.filter(n => this.matchingRepos().some(r => isAtOrInside(r.root, n.uri.fsPath))) : nodes;
    }
    const uri = node?.uri ?? folders[0]?.uri;
    if (!uri) return [];
    if (!this.filtering) {
      if (node) this.scanOnExpand(uri.fsPath);
      return this.readDir(uri);
    }
    if (node?.change) {
      // An untracked folder is new as a whole, so everything inside it is a change.
      const excluded = this.excludedNames();
      return (await this.readDir(uri))
        .filter(child => !(child.isDir && excluded.has(path.basename(child.uri.fsPath))))
        .map(child => ({ ...child, change: node.change }));
    }
    return this.filteredChildren(uri);
  }

  /** The folder new files go into: the selected folder, or the folder of the selected file. */
  selectedFolder(): vscode.Uri | undefined {
    const selected = this.treeView?.selection[0];
    return selected ? folderOf(selected) : localFolders()[0]?.uri;
  }

  /** Selects a file or folder in the tree, expanding the folders above it. */
  async reveal(uri: vscode.Uri, isDir: boolean): Promise<void> {
    const node = isDir ? this.dirNode(uri) : { uri, isDir: false };
    try {
      await this.treeView?.reveal(node, { select: true, focus: false, expand: isDir });
    } catch {
      // Not shown in the tree, for example because of the filter buttons.
    }
  }

  getParent(node: ExplorerNode): ExplorerNode | undefined {
    // Must match getChildren: with one folder its contents are the top level, otherwise the folders are.
    const folders = localFolders();
    if (isWorkspaceFolder(node.uri.fsPath)) return undefined;
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
      item.contextValue = this.withHosted('file', fsPath);
      if (node.change) {
        // Listed because it changed: clicking shows what changed, like Source Control.
        item.description = describeChange(node.change);
        item.contextValue = this.withHosted(node.change.letter === 'D' ? 'file change deleted' : 'file change', fsPath);
        item.command = { command: 'multiGitExplorer.openChange', title: 'Open Changes', arguments: [node, CLICK_OPEN] };
      } else {
        item.command = { command: 'vscode.open', title: 'Open', arguments: [node.uri, CLICK_OPEN] };
      }
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
      item.contextValue = this.withHosted(repo.view.contextValue, fsPath);
      if (this.filtering && !this.showsFilesOf(repo) && !this.matchingRepos().some(r => isInside(r.root, fsPath))) {
        item.collapsibleState = vscode.TreeItemCollapsibleState.None;
      }
      return item;
    }

    item.contextValue = this.withHosted('folder', fsPath);
    if (node.change) item.description = 'untracked';
    if (this.store.repoContaining(fsPath)) return item;

    const below = this.filtering ? this.matchingRepos().filter(r => isInside(r.root, fsPath)) : this.store.reposUnder(fsPath);
    if (below.length > 0) {
      item.description = summarize(below);
    } else if (this.store.isScanned(fsPath)) {
      item.description = 'no git';
    } else if (this.isExcluded(fsPath)) {
      item.description = 'excluded';
    } else {
      item.description = 'not scanned';
      item.tooltip = 'Past the scan depth limit. Expand it, or right-click and choose Scan This Folder.';
      item.contextValue = 'folder unscanned';
    }
    return item;
  }

  /**
   * Adds `hosted` for rows in a repo with a remote, which can be linked to on
   * its website, and `root` for workspace folders, which can't be renamed,
   * moved or deleted from the tree.
   */
  private withHosted(contextValue: string, fsPath: string): string {
    const tokens = [contextValue];
    if (this.store.repoContaining(fsPath)?.cheap?.hasRemote) tokens.push('hosted');
    if (isWorkspaceFolder(fsPath)) tokens.push('root');
    return tokens.join(' ');
  }

  /** Whether a folder was past the depth limit, so its repos aren't known yet. */
  private isUnscanned(fsPath: string): boolean {
    return (
      !this.store.get(fsPath) &&
      !this.store.repoContaining(fsPath) &&
      !this.store.isScanned(fsPath) &&
      !this.isExcluded(fsPath) &&
      this.store.reposUnder(fsPath).length === 0
    );
  }

  /**
   * Opening a folder that was past the depth limit searches it, so the repos
   * inside show their branch. Each folder is tried once, so a folder that can't
   * be read doesn't search again on every refresh.
   */
  private scanOnExpand(fsPath: string): void {
    if (this.autoScanned.has(fsPath) || !this.isUnscanned(fsPath)) return;
    this.autoScanned.add(fsPath);
    void this.store.scanFolder(fsPath);
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
    // Changed files come straight from git, so leave out what the unfiltered
    // tree hides (files.exclude) and the folders that are never searched.
    const excluded = this.excludedNames();
    const entries = filteredEntries(uri.fsPath, matching.map(r => r.root), changes).filter(
      entry => !(entry.isDir && excluded.has(entry.name)),
    );
    // A deleted file is listed too, so siblings for `when` clauses come from the disk.
    return this.visibleEntries(uri.fsPath, entries, name => existsSync(path.join(uri.fsPath, name)))
      .map(entry => {
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
    const names = new Set(entries.map(([name]) => name));
    const listed = entries.map(([name, type]) => ({ name, isDir: (type & vscode.FileType.Directory) !== 0 }));
    return this.visibleEntries(uri.fsPath, listed, name => names.has(name))
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

  /**
   * The entries of `dir` that `files.exclude` doesn't hide, judged like the
   * built-in Explorer: with `when` clauses and `!` exceptions, and keeping
   * excluded items shown while a visible editor is at or inside them.
   */
  private visibleEntries<T extends { name: string; isDir: boolean }>(
    dir: string,
    entries: T[],
    hasSibling: (name: string) => boolean,
  ): T[] {
    const root = closestFolder(dir);
    if (!root) return entries;
    const rules = this.excludeRulesFor(root);
    const parent = dir === root ? ROOT_STATE : (this.visibility.get(dir) ?? ROOT_STATE);
    return entries.filter(entry => {
      const fsPath = path.join(dir, entry.name);
      const result = checkEntry(rules, {
        relPath: repoRelative(root, fsPath),
        name: entry.name,
        isDir: entry.isDir,
        parent,
        hasSibling,
        hasEditorInside: () => this.noteEditorInside(fsPath, root),
      });
      this.visibility.set(fsPath, result.state);
      return result.visible;
    });
  }

  private excludeRulesFor(root: string): ExcludeRules {
    let rules = this.excludeRules.get(root);
    if (!rules) {
      const config = vscode.workspace.getConfiguration('files', vscode.Uri.file(root));
      rules = parseExcludes(config.get<Record<string, boolean | { when: string }>>('exclude'));
      this.excludeRules.set(root, rules);
    }
    return rules;
  }

  /** Whether a visible editor shows `fsPath` or a file inside it, in the same workspace folder. */
  private noteEditorInside(fsPath: string, root: string): boolean {
    let found = false;
    for (const file of this.visibleEditors) {
      if (isAtOrInside(file, fsPath) && closestFolder(file) === root) {
        this.editorsShowingExcluded.add(file);
        found = true;
      }
    }
    return found;
  }

  /**
   * Like the built-in Explorer: refilter when an editor opens a file that is
   * excluded, or an editor that kept an excluded item shown is gone.
   */
  private onVisibleEditorsChanged(): void {
    const editors = visibleEditorFiles();
    const same = editors.size === this.visibleEditors.size && [...editors].every(f => this.visibleEditors.has(f));
    this.visibleEditors = editors;
    if (same) return;
    const opensExcluded = [...editors].some(file => this.closestKnownState(file)?.isExcluded);
    const closedShowing = [...this.editorsShowingExcluded].some(file => !editors.has(file));
    if (opensExcluded || closedShowing) {
      this.editorsShowingExcluded.clear();
      this.refreshAll();
    }
  }

  /** The state of the deepest item at or above `fsPath` that the tree has judged. */
  private closestKnownState(fsPath: string): VisibilityState | undefined {
    for (let dir = fsPath; ; dir = path.dirname(dir)) {
      const state = this.visibility.get(dir);
      if (state) return state;
      if (path.dirname(dir) === dir) return undefined;
    }
  }

  /** Folder names in `multiGitExplorer.exclude`. */
  private excludedNames(): Set<string> {
    return new Set(vscode.workspace.getConfiguration('multiGitExplorer').get<string[]>('exclude', []));
  }

  private isExcluded(fsPath: string): boolean {
    const name = path.basename(fsPath);
    return name.startsWith('.') || this.excludedNames().has(name);
  }

  private refreshAll(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    this.visibility.clear();
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
    const isTopLevel = isWorkspaceFolder(dir);
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


function summarize(repos: RepoEntry[]): string {
  const parts = [`${repos.length} ${repos.length === 1 ? 'repo' : 'repos'}`];
  const counts = SUMMARY_SYMBOLS.map(
    ([groups, symbol]) => [symbol, repos.filter(r => groups.includes(r.view.group)).length] as const,
  ).filter(([, n]) => n > 0);
  parts.push(counts.length ? counts.map(([symbol, n]) => `${symbol}${n}`).join(' ') : 'all clean');
  return parts.join(' · ');
}

/** The workspace folder that holds `fsPath`; the innermost one when folders are nested. */
function closestFolder(fsPath: string): string | undefined {
  let best: string | undefined;
  for (const folder of localFolders()) {
    const root = folder.uri.fsPath;
    if (isAtOrInside(fsPath, root) && (!best || root.length > best.length)) best = root;
  }
  return best;
}

/** Files shown in the visible editors: the active tab of each group. Diff editors don't count, as in the built-in Explorer. */
function visibleEditorFiles(): Set<string> {
  const files = new Set<string>();
  for (const group of vscode.window.tabGroups.all) {
    const input = group.activeTab?.input;
    if (
      input instanceof vscode.TabInputText ||
      input instanceof vscode.TabInputCustom ||
      input instanceof vscode.TabInputNotebook
    ) {
      if (input.uri.scheme === 'file') files.add(input.uri.fsPath);
    }
  }
  return files;
}
