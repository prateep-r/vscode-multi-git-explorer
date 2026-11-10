import * as path from 'path';
import * as vscode from 'vscode';
import { discoverRepos } from './core/discovery';
import { readStatus } from './core/git';
import { readCheapState, readFingerprint, type CheapState } from './core/gitDir';
import { isInside, withSep } from './core/paths';
import { gitPath, localFolders } from './workspace';
import type { ChangedFile, StatusSummary } from './core/porcelain';
import { Priority, TaskQueue, runPool } from './core/queue';
import { describeRepo, type RepoView } from './core/state';

export interface RepoEntry {
  root: string;
  name: string;
  isSubmodule: boolean;
  cheap?: CheapState;
  status?: StatusSummary;
  /** Changed files by path relative to the root (forward slashes; untracked folders end with "/"). */
  changes?: Map<string, ChangedFile>;
  error?: string;
  /** What `.git` looked like when the last check started (see `readFingerprint`). */
  fingerprint?: string;
  /** True once a status check has been asked for since the last change. */
  requested: boolean;
  view: RepoView;
}

const CHEAP_READ_CONCURRENCY = 32;
const CHANGE_DEBOUNCE_MS = 400;
/** How long to wait after folders appear or go away before searching for repos again. */
const DISCOVER_DEBOUNCE_MS = 500;
const EMIT_BATCH_MS = 100;
const FOCUS_THROTTLE_MS = 10_000;
/**
 * Workspaces with more repos than this are checked more sparingly, since a
 * git process per repo adds up: on focus and in the background only the
 * repos whose `.git` changed are checked, every repo only every
 * FULL_REFRESH_MS, and at startup the repos off screen wait STARTUP_PAUSE_MS.
 */
export const LARGE_WORKSPACE_REPOS = 100;
/**
 * How long the first search for repos in a large workspace waits before
 * checking the repos that aren't on screen, so VS Code and other extensions
 * can start up first.
 */
export const STARTUP_PAUSE_MS = 5_000;
/** How often the background refresh checks every repo of a large workspace, to catch what the file watcher missed. */
const FULL_REFRESH_MS = 30 * 60_000;
/** Files inside .git whose changes affect what we show. */
const RELEVANT_GIT_FILES = /^(HEAD|index|FETCH_HEAD|MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|ORIG_HEAD|config|packed-refs|refs|logs|rebase-merge|rebase-apply)$/;

function config() {
  return vscode.workspace.getConfiguration('multiGitExplorer');
}

/**
 * Keeps the state of every repo in the workspace up to date, while running
 * as few git processes as possible: branch and in-progress operations are
 * read straight from `.git`, and `git status` runs through a priority queue
 * so visible repos and repos the user is working in are checked first.
 */
export class RepoStore implements vscode.Disposable {
  private readonly repos = new Map<string, RepoEntry>();
  /** Roots sorted longest first, so the first prefix match is the innermost repo. */
  /** Repo roots in sorted order, so the repos below a folder are next to each other. */
  private sortedRoots: string[] = [];
  private scanned = new Set<string>();
  /** Folders past the depth limit that the user scanned, searched again on every discovery. */
  private readonly userScans = new Set<string>();
  private readonly queue = new TaskQueue(config().get('maxConcurrency', 6));
  private readonly debounce = new Map<string, NodeJS.Timeout>();
  private pendingChanged = new Set<string>();
  private emitTimer?: NodeJS.Timeout;
  private discoverTimer?: NodeJS.Timeout;
  private lastFocusRefresh = 0;
  /** When every repo was last checked; the first checks count. */
  private lastFullRefresh = Date.now();
  private backgroundTimer?: NodeJS.Timeout;
  private startupTimer?: NodeJS.Timeout;
  private discovered = false;
  private discovering?: Promise<void>;
  private readonly disposables: vscode.Disposable[] = [];

  private readonly _onDidChangeRepos = new vscode.EventEmitter<string[]>();
  /** Fires with the roots of repos whose state changed. */
  readonly onDidChangeRepos = this._onDidChangeRepos.event;

  private readonly _onDidDiscover = new vscode.EventEmitter<void>();
  /** Fires when the set of repos or scanned folders changed. */
  readonly onDidDiscover = this._onDidDiscover.event;

  private readonly _onDidChangeFolder = new vscode.EventEmitter<string>();
  /** Fires with a folder whose direct contents changed (file added or removed). */
  readonly onDidChangeFolder = this._onDidChangeFolder.event;

  constructor(private readonly log: vscode.OutputChannel) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    this.disposables.push(
      watcher,
      watcher.onDidChange(uri => this.onFileEvent(uri, 'change')),
      watcher.onDidCreate(uri => this.onFileEvent(uri, 'create')),
      watcher.onDidDelete(uri => this.onFileEvent(uri, 'delete')),
      vscode.window.onDidChangeWindowState(state => state.focused && this.onWindowFocus()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.discover()),
      vscode.workspace.onDidChangeConfiguration(e => this.onConfigChange(e)),
      this._onDidChangeRepos,
      this._onDidDiscover,
      this._onDidChangeFolder,
    );
    this.startBackgroundRefresh();
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
    this.queue.clear();
    this.debounce.forEach(clearTimeout);
    clearTimeout(this.emitTimer);
    clearTimeout(this.discoverTimer);
    clearTimeout(this.startupTimer);
    clearInterval(this.backgroundTimer);
  }

  // ---- Queries ------------------------------------------------------------

  all(): RepoEntry[] {
    return [...this.repos.values()];
  }

  get(root: string): RepoEntry | undefined {
    return this.repos.get(root);
  }

  /**
   * The innermost repo that contains `fsPath` (or is `fsPath`). It walks up
   * from the path, so it takes as long as the path is deep, however many repos
   * there are; drawing a row asks for it.
   */
  repoContaining(fsPath: string): RepoEntry | undefined {
    let dir = fsPath;
    while (!this.repos.has(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
    return this.repos.get(dir);
  }

  /** Repos strictly below `dir`, found by a binary search of the sorted roots. */
  reposUnder(dir: string): RepoEntry[] {
    const prefix = withSep(dir);
    let low = 0;
    let high = this.sortedRoots.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (this.sortedRoots[mid] < prefix) low = mid + 1;
      else high = mid;
    }
    const found: RepoEntry[] = [];
    for (let i = low; i < this.sortedRoots.length && this.sortedRoots[i].startsWith(prefix); i++) found.push(this.repos.get(this.sortedRoots[i])!);
    return found;
  }

  isScanned(dir: string): boolean {
    return this.scanned.has(dir);
  }

  /** How many repos have finished their first status check. */
  progress(): { done: number; total: number } {
    let done = 0;
    for (const repo of this.repos.values()) if (repo.status || repo.error) done++;
    return { done, total: this.repos.size };
  }

  // ---- Discovery ----------------------------------------------------------

  /** Searches all workspace folders for repos. */
  discover(): Promise<void> {
    if (!this.discovering) {
      this.discovering = this.doDiscover().finally(() => (this.discovering = undefined));
    }
    return this.discovering;
  }

  private async doDiscover(): Promise<void> {
    const roots = localFolders().map(f => f.uri.fsPath);
    const started = Date.now();
    // Folders scanned by hand stay scanned, as long as they're still in the workspace.
    const scans = [...this.userScans].filter(dir => roots.some(root => isInside(dir, root)));
    const [result, scanned] = await Promise.all([
      discoverRepos(roots, this.discoveryOptions()),
      discoverRepos(scans, this.discoveryOptions()),
    ]);
    result.repos.push(...scanned.repos);
    result.scannedDirs.push(...scanned.scannedDirs);

    const found = new Set(result.repos.map(r => r.root));
    for (const root of this.repos.keys()) {
      if (!found.has(root)) this.repos.delete(root);
    }
    const added: RepoEntry[] = [];
    for (const repo of result.repos) {
      if (!this.repos.has(repo.root)) {
        const entry = this.newEntry(repo.root, repo.isSubmodule);
        this.repos.set(repo.root, entry);
        added.push(entry);
      }
    }
    this.scanned = new Set(result.scannedDirs);
    this.reindex();
    this.log.appendLine(
      `Found ${this.repos.size} repos in ${result.scannedDirs.length} folders (${Date.now() - started} ms)`,
    );

    await this.readCheapStates(added);
    this._onDidDiscover.fire();
    // Only repos still here: another search may have dropped some meanwhile.
    const checkAdded = () => {
      for (const entry of added) if (this.repos.get(entry.root) === entry) this.requestStatus(entry, Priority.Background);
    };
    // In a large workspace, repos drawn on screen are asked for during the pause, by the decorations.
    if (this.discovered || !this.isLarge()) checkAdded();
    else this.startupTimer = setTimeout(checkAdded, STARTUP_PAUSE_MS);
    this.discovered = true;
  }

  /** Searches one folder that was past the depth limit. */
  async scanFolder(dir: string): Promise<void> {
    this.userScans.add(dir);
    const result = await discoverRepos([dir], this.discoveryOptions());
    const added = result.repos.filter(r => !this.repos.has(r.root)).map(r => this.newEntry(r.root, r.isSubmodule));
    for (const entry of added) this.repos.set(entry.root, entry);
    result.scannedDirs.forEach(d => this.scanned.add(d));
    this.reindex();
    await this.readCheapStates(added);
    this._onDidDiscover.fire();
    for (const entry of added) this.requestStatus(entry, Priority.User);
  }

  private discoveryOptions() {
    return {
      maxDepth: config().get('scanDepth', 10),
      exclude: new Set(config().get<string[]>('exclude', [])),
    };
  }

  private newEntry(root: string, isSubmodule: boolean): RepoEntry {
    const entry: RepoEntry = {
      root,
      name: path.basename(root),
      isSubmodule,
      requested: false,
      view: undefined!,
    };
    entry.view = this.describe(entry);
    return entry;
  }

  private reindex(): void {
    this.sortedRoots = [...this.repos.keys()].sort();
    void vscode.commands.executeCommand(
      'setContext',
      'multiGitExplorer.repoPaths',
      Object.fromEntries([...this.repos.keys()].map(root => [root, true])),
    );
  }

  private async readCheapStates(entries: RepoEntry[]): Promise<void> {
    await runPool(entries, CHEAP_READ_CONCURRENCY, async entry => {
      entry.cheap = await readCheapState(entry.root);
      entry.view = this.describe(entry);
    });
  }

  // ---- Refreshing ---------------------------------------------------------

  /** Asks for a status check unless one was already asked for. Cheap to call often. */
  requestStatus(entry: RepoEntry, priority: number): void {
    if (entry.requested && !this.queue.has(entry.root)) return;
    entry.requested = true;
    this.queue.enqueue(entry.root, priority, () => this.check(entry));
  }

  /** Re-reads a repo, even if nothing seems to have changed. */
  refresh(root: string, priority: number = Priority.User): void {
    const entry = this.repos.get(root);
    if (!entry) return;
    entry.requested = true;
    this.queue.enqueue(root, priority, () => this.check(entry));
  }

  refreshAll(priority: number = Priority.Background): void {
    this.lastFullRefresh = Date.now();
    const active = this.activeRepo();
    for (const root of this.repos.keys()) {
      this.refresh(root, root === active?.root ? Priority.Active : priority);
    }
  }

  /**
   * Re-checks the repos whose `.git` changed since their last check, those
   * whose check failed, and the active editor's repo. Telling which changed
   * reads a few files per repo and starts no process, so it suits large
   * workspaces, where `refreshAll` would start a git process for every repo.
   * The working tree isn't looked at: the file watcher reports changes there.
   * Repos not checked yet are left to the check that's coming.
   */
  async refreshChanged(): Promise<void> {
    const active = this.activeRepo();
    if (active) this.refresh(active.root, Priority.Active);
    await runPool(this.all(), CHEAP_READ_CONCURRENCY, async entry => {
      if (entry === active || (!entry.status && entry.error === undefined)) return;
      if (entry.error !== undefined || (await readFingerprint(entry.root)) !== entry.fingerprint) {
        this.refresh(entry.root, Priority.Background);
      }
    });
  }

  /** Whether the workspace has more than LARGE_WORKSPACE_REPOS repos, and so is checked more sparingly. */
  isLarge(): boolean {
    return this.repos.size > LARGE_WORKSPACE_REPOS;
  }

  /** The repo of the file in the active editor. */
  activeRepo(): RepoEntry | undefined {
    const uri = vscode.window.activeTextEditor?.document.uri;
    return uri?.scheme === 'file' ? this.repoContaining(uri.fsPath) : undefined;
  }

  private async check(entry: RepoEntry): Promise<void> {
    const { root } = entry;
    // Read before git runs, so a change made while it runs is seen next time.
    entry.fingerprint = await readFingerprint(root);
    try {
      const [cheap, status] = await Promise.all([
        readCheapState(root),
        readStatus(root, config().get('countUntracked', true), { gitPath: gitPath() }),
      ]);
      entry.cheap = cheap;
      entry.status = status;
      entry.changes = new Map(status.files.map(file => [file.path, file]));
      entry.error = undefined;
    } catch (error) {
      // readStatus fails only with a GitError.
      entry.error = (error as Error).message;
      // It reads .git by hand and never fails. Without .git, the repo is gone;
      // the watcher may report only the files inside .git going away.
      entry.cheap = await readCheapState(root);
      if (!entry.cheap) this.scheduleDiscover();
      this.log.appendLine(`${root}: ${entry.error}`);
    }
    entry.view = this.describe(entry);
    this.markChanged(root);
    // The repo a submodule is in lists it as changed when it has new commits or changes,
    // which neither the watcher (it reports a file to its innermost repo) nor the parent's .git shows.
    const parent = entry.isSubmodule ? this.repoContaining(path.dirname(root)) : undefined;
    if (parent) this.refresh(parent.root, Priority.Background);
  }

  private describe(entry: RepoEntry): RepoView {
    return describeRepo({
      name: entry.name,
      isSubmodule: entry.isSubmodule,
      cheap: entry.cheap,
      status: entry.status,
      error: entry.error,
    });
  }

  private markChanged(root: string): void {
    this.pendingChanged.add(root);
    this.emitTimer ??= setTimeout(() => {
      this.emitTimer = undefined;
      const roots = [...this.pendingChanged];
      this.pendingChanged.clear();
      this._onDidChangeRepos.fire(roots);
    }, EMIT_BATCH_MS);
  }

  private scheduleRefresh(root: string): void {
    clearTimeout(this.debounce.get(root));
    this.debounce.set(
      root,
      setTimeout(() => {
        this.debounce.delete(root);
        this.refresh(root, Priority.Active);
      }, CHANGE_DEBOUNCE_MS),
    );
  }

  // ---- Events ---------------------------------------------------------------

  /** For the watcher, which reports only files on disk, as only local folders are supported. */
  private onFileEvent(uri: vscode.Uri, kind: 'change' | 'create' | 'delete'): void {
    const fsPath = uri.fsPath;
    const marker = `${path.sep}.git${path.sep}`;
    const gitIndex = fsPath.indexOf(marker);

    if (gitIndex >= 0) {
      const root = fsPath.slice(0, gitIndex);
      const inside = fsPath.slice(gitIndex + marker.length).split(path.sep)[0];
      if (this.repos.has(root) && RELEVANT_GIT_FILES.test(inside)) this.scheduleRefresh(root);
      return;
    }

    if (kind !== 'change') {
      const parent = path.dirname(fsPath);
      this._onDidChangeFolder.fire(parent);
      // A new or removed .git folder means a repo appeared or went away.
      if (path.basename(fsPath) === '.git' && (this.scanned.has(parent) || this.repos.has(parent))) {
        this.scheduleDiscover();
        return;
      }
      // So may anything that appears where repos are searched for, such as a
      // folder made by git clone, which may be reported as the folder alone,
      // and a searched folder that goes away. Searching is quick, and rarely
      // needed, as files seldom change outside repos.
      if (this.scanned.has(parent) && !this.repos.has(parent) && (kind === 'create' || this.scanned.has(fsPath))) {
        this.scheduleDiscover();
      }
    }
    const repo = this.repoContaining(fsPath);
    if (repo) this.scheduleRefresh(repo.root);
  }

  private scheduleDiscover(): void {
    clearTimeout(this.discoverTimer);
    this.discoverTimer = setTimeout(() => void this.discover(), DISCOVER_DEBOUNCE_MS);
  }

  private onWindowFocus(): void {
    if (!config().get('refreshOnFocus', true)) return;
    const now = Date.now();
    if (now - this.lastFocusRefresh < FOCUS_THROTTLE_MS) return;
    this.lastFocusRefresh = now;
    if (this.isLarge()) void this.refreshChanged();
    else this.refreshAll(Priority.Background);
  }

  private onBackgroundTick(): void {
    if (this.isLarge() && Date.now() - this.lastFullRefresh < FULL_REFRESH_MS) void this.refreshChanged();
    else this.refreshAll(Priority.Background);
  }

  private onConfigChange(e: vscode.ConfigurationChangeEvent): void {
    if (e.affectsConfiguration('multiGitExplorer.maxConcurrency')) {
      this.queue.setConcurrency(config().get('maxConcurrency', 6));
    }
    if (e.affectsConfiguration('multiGitExplorer.scanDepth') || e.affectsConfiguration('multiGitExplorer.exclude')) {
      void this.discover();
    }
    if (e.affectsConfiguration('multiGitExplorer.countUntracked')) this.refreshAll();
    if (e.affectsConfiguration('multiGitExplorer.backgroundRefreshMinutes')) this.startBackgroundRefresh();
  }

  private startBackgroundRefresh(): void {
    clearInterval(this.backgroundTimer);
    const minutes = config().get('backgroundRefreshMinutes', 5);
    if (minutes > 0) {
      this.backgroundTimer = setInterval(() => this.onBackgroundTick(), minutes * 60_000);
    }
  }
}
