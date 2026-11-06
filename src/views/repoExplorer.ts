import { existsSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { FILTER_LABELS, describeChange, filteredEntries, matchesFilter, type ExplorerFilter } from '../core/filter';
import { compactChain } from '../core/compact';
import { makeNester, nestFiles } from '../core/nesting';
import type { ExplorerFileNestingTrie } from '../core/vs/explorerFileNestingTrie';
import { firstPartBelow, isAtOrInside, isInside, repoRelative } from '../core/paths';
import type { ChangedFile } from '../core/porcelain';
import { compareEntries, readSortConfig, type Sortable } from '../core/sort';
import type { GroupKey } from '../core/state';
import { checkEntry, parseExcludes, ROOT_STATE, type ExcludeRules, type VisibilityState } from '../core/visibility';
import { IgnoreFile } from '../core/vs/ignoreFile';
import type { RepoEntry, RepoStore } from '../store';
import { folderOf, isWorkspaceFolder, localFolders } from '../workspace';
import { toViewUri } from './viewUri';

export interface ExplorerNode {
  /** What commands act on. For a compact row, the last folder of `compact`. */
  uri: vscode.Uri;
  isDir: boolean;
  /** For a changed file (or untracked folder) listed while filtering. */
  change?: ChangedFile;
  /** For a compact row (`explorer.compactFolders`): its folders, outermost first. */
  compact?: vscode.Uri[];
  /** For a file with files nested under it (`explorer.fileNesting`). */
  nested?: ExplorerNode[];
}

/** The first folder of a row: itself, or the outermost folder of a compact row. Rows are keyed by it. */
export function headOf(node: ExplorerNode): string {
  return (node.compact?.[0] ?? node.uri).fsPath;
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
  /** Folder nodes handed out so far, by their first folder, so updates can target them. */
  private readonly dirNodes = new Map<string, ExplorerNode>();
  /** Every folder of a compact row, to its row. */
  private readonly chainMember = new Map<string, ExplorerNode>();
  /** Files with files nested under them, and each nested file's parent. */
  private readonly nestParents = new Map<string, ExplorerNode>();
  private readonly nestParentOf = new Map<string, ExplorerNode>();
  /** Nest parents the user opened or closed, overriding `explorer.fileNesting.expand`. */
  private readonly nestOpen = new Map<string, boolean>();
  private readonly nesters = new Map<string, ExplorerFileNestingTrie>();
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
  /**
   * For `explorer.excludeGitIgnore`: the `.gitignore` files of each workspace
   * folder met so far, by the folder they're in, each chained to the one
   * above it, as the built-in Explorer keeps them.
   */
  private readonly ignoreFiles = new Map<string, Map<string, IgnoreFile>>();

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
        } else if (e.affectsConfiguration('explorer.compactFolders') || e.affectsConfiguration('editor.accessibilitySupport')) {
          this.resetCompaction();
          this.refreshAll();
        } else if (e.affectsConfiguration('explorer.fileNesting')) {
          this.nesters.clear();
          this.refreshAll();
        } else if (e.affectsConfiguration('explorer.excludeGitIgnore')) {
          this.ignoreFiles.clear();
          this.refreshAll();
        } else if (e.affectsConfiguration('explorer.sortOrder') || e.affectsConfiguration('explorer.sortOrderLexicographicOptions') || e.affectsConfiguration('explorer.sortOrderReverse')) {
          this.refreshAll();
        }
      }),
      ...this.watchIgnoreFiles(),
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
    this.disposables.push(
      treeView.onDidExpandElement(e => {
        if (e.element.nested) this.nestOpen.set(e.element.uri.fsPath, true);
      }),
      treeView.onDidCollapseElement(e => {
        if (e.element.nested) this.nestOpen.set(e.element.uri.fsPath, false);
      }),
    );
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
    // Rows are shared by both trees, and what makes a chain differs between them.
    this.resetCompaction();
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
    if (node && !node.isDir) return node.nested ?? [];
    const folders = localFolders();
    if (!node && folders.length !== 1) {
      const nodes = folders.map(f => this.dirNode(f.uri));
      return this.filtering ? nodes.filter(n => this.matchingRepos().some(r => isAtOrInside(r.root, n.uri.fsPath))) : nodes;
    }
    if (node?.isDir && !node.change && (await this.updateChain(node))) {
      // The row's name changed, so have VS Code ask for it again.
      setTimeout(() => this._onDidChangeTreeData.fire(node), 0);
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
    return await this.filteredChildren(uri);
  }

  /** The folder new files go into: the selected folder, or the folder of the selected file. */
  selectedFolder(): vscode.Uri | undefined {
    const selected = this.treeView?.selection[0];
    return selected ? folderOf(selected) : localFolders()[0]?.uri;
  }

  /**
   * The row with keyboard focus. The API doesn't expose it, so this toggles
   * the focused row's selection with `list.toggleSelection`, sees which row
   * changed, and toggles it back. Only call it while the tree has focus, as
   * keyboard shortcuts limited to the tree are.
   */
  async focusedRow(): Promise<ExplorerNode | undefined> {
    const tree = this.treeView;
    if (!tree) return undefined;
    const key = (n: ExplorerNode) => n.uri.fsPath;
    const before = tree.selection;
    const toggle = async (): Promise<readonly ExplorerNode[]> => {
      const changed = new Promise<readonly ExplorerNode[] | undefined>(resolve => {
        const timer = setTimeout(() => done(undefined), 500);
        const sub = tree.onDidChangeSelection(e => done(e.selection));
        function done(selection: readonly ExplorerNode[] | undefined) {
          clearTimeout(timer);
          sub.dispose();
          resolve(selection);
        }
      });
      await vscode.commands.executeCommand('list.toggleSelection');
      return (await changed) ?? tree.selection;
    };
    const after = await toggle();
    const was = new Set(before.map(key));
    const now = new Set(after.map(key));
    const focused = after.find(n => !was.has(key(n))) ?? before.find(n => !now.has(key(n)));
    if (focused) await toggle();
    return focused;
  }

  /**
   * The rows a keyboard shortcut acts on, like the built-in Explorer: the
   * selection when the focused row is part of it, otherwise the focused row.
   */
  async keyboardRows(focusedRow?: ExplorerNode): Promise<ExplorerNode[]> {
    const selection = this.treeView?.selection ?? [];
    const focused = focusedRow ?? (await this.focusedRow());
    if (!focused) return [...selection];
    return selection.some(n => n.uri.fsPath === focused.uri.fsPath) ? [...selection] : [focused];
  }

  /** Selects a file or folder in the tree, expanding the folders above it. */
  async reveal(uri: vscode.Uri, isDir: boolean): Promise<void> {
    await this.resolvePath(uri.fsPath);
    const node = isDir ? (this.chainMember.get(uri.fsPath) ?? this.dirNode(uri)) : { uri, isDir: false };
    try {
      await this.treeView?.reveal(node, { select: true, focus: false, expand: isDir });
    } catch {
      // Not shown in the tree, for example because of the filter buttons.
    }
  }

  getParent(node: ExplorerNode): ExplorerNode | undefined {
    // Must match getChildren: with one folder its contents are the top level, otherwise the folders are.
    const folders = localFolders();
    if (!node.isDir) {
      const nestParent = this.nestParentOf.get(node.uri.fsPath);
      if (nestParent) return nestParent;
    }
    const head = headOf(node);
    if (isWorkspaceFolder(head)) return undefined;
    const parent = vscode.Uri.file(path.dirname(head));
    if (folders.length === 1 && folders[0].uri.fsPath === parent.fsPath) return undefined;
    // A compact row is the parent of what's in its last folder.
    return this.dirNode(parent);
  }

  /**
   * Lists the folders down to `target` the way the tree does, so the chains
   * of compact rows on the way are known before VS Code is asked to reveal it.
   */
  private async resolvePath(target: string): Promise<void> {
    const root = closestFolder(target);
    if (!root || root === target) return;
    let node: ExplorerNode | undefined = localFolders().length === 1 ? undefined : this.dirNode(vscode.Uri.file(root));
    for (let depth = 0; depth < 256; depth++) {
      const children = await this.getChildren(node);
      const last = node ? node.uri.fsPath : root;
      if (!isInside(target, last)) return;
      const next = path.join(last, firstPartBelow(target, last));
      if (next === target) return;
      const child = children.find(c => c.isDir && headOf(c) === next);
      if (!child) return;
      node = child;
    }
  }

  private compactionOn(): boolean {
    // Like the built-in Explorer, compact folders aren't used with a screen reader.
    return (
      vscode.workspace.getConfiguration('explorer').get<boolean>('compactFolders') !== false &&
      vscode.workspace.getConfiguration('editor').get('accessibilitySupport') !== 'on'
    );
  }

  /**
   * Works out the folders a row shows, as the built-in Explorer does when a
   * folder is opened: it takes in its only child folder, and that one's, and
   * so on. Workspace folders take in nothing. Returns whether the row changed.
   */
  private async updateChain(node: ExplorerNode): Promise<boolean> {
    const head = headOf(node);
    const chain =
      this.compactionOn() && !isWorkspaceFolder(head)
        ? await compactChain(head, dir => (this.filtering ? this.onlyFilteredChildFolder(dir) : onlyChildFolder(dir)))
        : [head];
    const current = node.compact?.map(u => u.fsPath) ?? [head];
    if (chain.length === current.length && chain.every((p, i) => p === current[i])) return false;
    for (const member of current) if (this.chainMember.get(member) === node) this.chainMember.delete(member);
    node.uri = vscode.Uri.file(chain[chain.length - 1]);
    if (chain.length > 1) {
      node.compact = chain.map(p => vscode.Uri.file(p));
      for (const member of chain) this.chainMember.set(member, node);
    } else {
      delete node.compact;
    }
    return true;
  }

  /** While filtering: the only folder a folder lists, if that's all it lists. Untracked folders end a chain. */
  private async onlyFilteredChildFolder(dir: string): Promise<string | undefined> {
    const children = await this.filteredChildren(vscode.Uri.file(dir));
    return children.length === 1 && children[0].isDir && !children[0].change ? children[0].uri.fsPath : undefined;
  }

  /** Turns every compact row back into its first folder. */
  private resetCompaction(): void {
    for (const node of new Set(this.chainMember.values())) {
      if (node.compact) node.uri = node.compact[0];
      delete node.compact;
    }
    this.chainMember.clear();
  }

  getTreeItem(node: ExplorerNode): vscode.TreeItem {
    const fsPath = node.uri.fsPath;
    // Separate ids per mode, so filtered folders open expanded without
    // changing what the user expanded in the unfiltered tree. A compact row
    // is keyed by its first folder, so it stays open as its chain changes.
    const id = `${this.filtering ? `f:${this.activeFilters.join(',')}` : 'all'}:${headOf(node)}`;

    if (!node.isDir) {
      const item = new vscode.TreeItem(
        toViewUri(fsPath),
        !node.nested?.length
          ? vscode.TreeItemCollapsibleState.None
          : this.isNestOpen(node)
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.Collapsed,
      );
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
    if (node.compact) item.label = node.compact.map(u => path.basename(u.fsPath)).join('/');
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

  private async filteredChildren(uri: vscode.Uri): Promise<ExplorerNode[]> {
    const matching = this.matchingRepos();
    const changes = matching.filter(r => this.showsFilesOf(r)).map(r => ({ root: r.root, files: r.status!.files }));
    // Changed files come straight from git, so leave out what the unfiltered
    // tree hides (files.exclude) and the folders that are never searched.
    const excluded = this.excludedNames();
    const entries = filteredEntries(uri.fsPath, matching.map(r => r.root), changes).filter(
      entry => !(entry.isDir && excluded.has(entry.name)),
    );
    if (existsSync(path.join(uri.fsPath, '.gitignore'))) await this.loadIgnoreFile(uri.fsPath);
    // A deleted file is listed too, so siblings for `when` clauses come from the disk.
    const visible = this.visibleEntries(uri.fsPath, entries, name => existsSync(path.join(uri.fsPath, name)));
    return (await this.sorted(uri.fsPath, visible))
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
    const dir = uri.fsPath;
    const names = new Set(entries.map(([name]) => name));
    const hasSibling = (name: string) => names.has(name);
    if (names.has('.gitignore')) await this.loadIgnoreFile(dir);
    const listed = entries.map(([name, type]) => ({ name, isDir: (type & vscode.FileType.Directory) !== 0, hasNests: false }));
    // Like the built-in Explorer, files are nested before any are hidden; nested files aren't listed on their own.
    const nests = this.nestsIn(dir, listed);
    const nestedNames = new Set([...nests.values()].flat());
    for (const entry of listed) entry.hasNests = (nests.get(entry.name)?.length ?? 0) > 0;
    for (const [child, parent] of this.nestParentOf) if (path.dirname(child) === dir && parent) this.nestParentOf.delete(child);
    const top = listed.filter(e => !nestedNames.has(e.name));
    return Promise.all(
      (await this.sorted(dir, this.visibleEntries(dir, top, hasSibling))).map(async ({ name, isDir, hasNests }) => {
        const child = vscode.Uri.joinPath(uri, name);
        if (isDir) return this.dirNode(child);
        if (!hasNests) {
          this.nestParents.delete(child.fsPath);
          return { uri: child, isDir: false };
        }
        let parent = this.nestParents.get(child.fsPath);
        if (!parent) this.nestParents.set(child.fsPath, (parent = { uri: child, isDir: false }));
        const kids = listed.filter(e => nests.get(name)!.includes(e.name));
        parent.nested = (await this.sorted(dir, this.visibleEntries(dir, kids, hasSibling))).map(k => ({
          uri: vscode.Uri.joinPath(uri, k.name),
          isDir: false,
        }));
        for (const kid of parent.nested) this.nestParentOf.set(kid.uri.fsPath, parent);
        return parent;
      }),
    );
  }

  /** Which files of `dir` nest under which, with `explorer.fileNesting` on. Not while filtering, which lists only changes. */
  private nestsIn(dir: string, entries: readonly { name: string; isDir: boolean }[]): Map<string, string[]> {
    const root = closestFolder(dir);
    if (this.filtering || !root) return new Map();
    const config = vscode.workspace.getConfiguration('explorer', vscode.Uri.file(root));
    if (config.get<boolean>('fileNesting.enabled') !== true) return new Map();
    const ignoreCase = process.platform !== 'linux';
    let nester = this.nesters.get(root);
    if (!nester) this.nesters.set(root, (nester = makeNester(config.get('fileNesting.patterns'), ignoreCase)));
    const files = entries.filter(e => !e.isDir).map(e => e.name);
    return nestFiles(nester, files, path.basename(dir), ignoreCase);
  }

  /** Whether a nest parent shows its nested files: as the user left it, otherwise per `explorer.fileNesting.expand`. */
  private isNestOpen(node: ExplorerNode): boolean {
    return this.nestOpen.get(node.uri.fsPath) ?? vscode.workspace.getConfiguration('explorer').get<boolean>('fileNesting.expand') !== false;
  }

  /**
   * Adds the nested files of closed nest parents, so cutting, copying,
   * deleting or dragging a parent takes them along, as in the built-in Explorer.
   */
  withNestedFiles(nodes: readonly ExplorerNode[]): ExplorerNode[] {
    const all = new Map(nodes.map(n => [n.uri.fsPath, n]));
    for (const n of nodes) {
      if (n.nested?.length && !this.isNestOpen(n)) for (const kid of n.nested) all.set(kid.uri.fsPath, kid);
    }
    return [...all.values()];
  }

  private dirNode(uri: vscode.Uri): ExplorerNode {
    const chained = this.chainMember.get(uri.fsPath);
    if (chained) return chained;
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
    const ignoring = this.excludesGitIgnore(root);
    return entries.filter(entry => {
      const fsPath = path.join(dir, entry.name);
      const result = checkEntry(rules, {
        relPath: repoRelative(root, fsPath),
        name: entry.name,
        isDir: entry.isDir,
        parent,
        isHidden: ignoring ? () => this.isGitIgnored(root, fsPath, entry.isDir) : undefined,
        hasSibling,
        hasEditorInside: () => this.noteEditorInside(fsPath, root),
      });
      this.visibility.set(fsPath, result.state);
      return result.visible;
    });
  }

  /**
   * Sorts a folder's entries by `explorer.sortOrder`, its lexicographic
   * options and `explorer.sortOrderReverse`, like the built-in Explorer.
   */
  private async sorted<T extends Sortable>(dir: string, entries: T[]): Promise<T[]> {
    const explorer = vscode.workspace.getConfiguration('explorer');
    const config = readSortConfig(
      explorer.get('sortOrder'),
      explorer.get('sortOrderLexicographicOptions'),
      explorer.get('sortOrderReverse'),
    );
    if (config.order === 'modified') {
      await Promise.all(
        entries.map(async entry => {
          try {
            entry.mtime = (await vscode.workspace.fs.stat(vscode.Uri.file(path.join(dir, entry.name)))).mtime;
          } catch {
            // Deleted files, listed while filtering, have no time and go last.
          }
        }),
      );
    }
    return entries.sort(compareEntries(config));
  }

  private excludesGitIgnore(root: string): boolean {
    return vscode.workspace.getConfiguration('explorer', vscode.Uri.file(root)).get<boolean>('excludeGitIgnore') === true;
  }

  /** Reads the `.gitignore` in `dir`, when `explorer.excludeGitIgnore` is on for its workspace folder. */
  private async loadIgnoreFile(dir: string, update = false): Promise<void> {
    const root = closestFolder(dir);
    if (!root || !this.excludesGitIgnore(root)) return;
    let files = this.ignoreFiles.get(root);
    if (!files) this.ignoreFiles.set(root, (files = new Map()));
    const existing = files.get(dir);
    if (existing && !update) return;
    let contents: string;
    try {
      contents = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(dir, '.gitignore'))));
    } catch {
      return;
    }
    if (existing) {
      existing.updateContents(contents);
      return;
    }
    // Paths are compared without case where the disk ignores it, as the built-in Explorer does.
    const ignoreCase = process.platform !== 'linux';
    files.set(dir, new IgnoreFile(contents, vscode.Uri.file(dir).path, closestIgnoreFile(files, dir), ignoreCase));
  }

  /** Whether `.gitignore` hides an item, judged by the nearest `.gitignore` at or above it. */
  private isGitIgnored(root: string, fsPath: string, isDir: boolean): boolean {
    const files = this.ignoreFiles.get(root);
    const ignoreFile = files && closestIgnoreFile(files, fsPath);
    return !!ignoreFile && !ignoreFile.isPathIncludedInTraversal(vscode.Uri.file(fsPath).path, isDir);
  }

  /** Keeps the `.gitignore` files in step with the disk, like the built-in Explorer. */
  private watchIgnoreFiles(): vscode.Disposable[] {
    const watcher = vscode.workspace.createFileSystemWatcher('**/.gitignore');
    const known = (uri: vscode.Uri) => {
      const root = closestFolder(uri.fsPath);
      return root ? this.ignoreFiles.get(root) : undefined;
    };
    return [
      watcher,
      watcher.onDidChange(async uri => {
        if (!known(uri)?.has(path.dirname(uri.fsPath))) return;
        await this.loadIgnoreFile(path.dirname(uri.fsPath), true);
        this.refreshAll();
      }),
      watcher.onDidCreate(uri => {
        if (known(uri)) this.refreshAll();
      }),
      watcher.onDidDelete(uri => {
        const files = known(uri);
        if (files?.delete(path.dirname(uri.fsPath))) {
          // The files below were chained to it, so read them again.
          for (const dir of [...files.keys()]) if (isInside(dir, path.dirname(uri.fsPath))) files.delete(dir);
          this.refreshAll();
        }
      }),
    ];
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
        const node = this.chainMember.get(dir) ?? this.dirNodes.get(dir);
        if (node) changed.add(node);
        if (path.dirname(dir) === dir) break;
      }
    }
    if (changed.size) this._onDidChangeTreeData.fire([...changed]);
  }

  private onFolderChanged(dir: string): void {
    if (this.filtering) return;
    const chained = this.chainMember.get(dir);
    if (chained) {
      // What's in the folder may lengthen or break the chain.
      void this.updateChain(chained).then(() => this._onDidChangeTreeData.fire(chained));
      return;
    }
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

/** The only entry of a folder on disk, if it's a folder. Hidden entries count, as in the built-in Explorer. */
async function onlyChildFolder(dir: string): Promise<string | undefined> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dir));
    return entries.length === 1 && (entries[0][1] & vscode.FileType.Directory) !== 0 ? path.join(dir, entries[0][0]) : undefined;
  } catch {
    return undefined;
  }
}

/** The `.gitignore` of the nearest folder at or above `fsPath` that has one. */
function closestIgnoreFile(files: ReadonlyMap<string, IgnoreFile>, fsPath: string): IgnoreFile | undefined {
  let best: string | undefined;
  for (const dir of files.keys()) {
    if (isAtOrInside(fsPath, dir) && (!best || dir.length > best.length)) best = dir;
  }
  return best === undefined ? undefined : files.get(best);
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
