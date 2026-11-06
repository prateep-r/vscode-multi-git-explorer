import * as path from 'path';
import * as vscode from 'vscode';
import { discoverRepos } from './core/discovery';
import { readStatus } from './core/git';
import { readCheapState, type CheapState } from './core/gitDir';
import { isAtOrInside, isInside } from './core/paths';
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
  /** True once a status check has been asked for since the last change. */
  requested: boolean;
  view: RepoView;
}

const CHEAP_READ_CONCURRENCY = 32;
const CHANGE_DEBOUNCE_MS = 400;
const EMIT_BATCH_MS = 100;
const FOCUS_THROTTLE_MS = 10_000;
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
  private rootsByLength: string[] = [];
  private scanned = new Set<string>();
  private readonly queue = new TaskQueue(config().get('maxConcurrency', 6));
  private readonly debounce = new Map<string, NodeJS.Timeout>();
  private pendingChanged = new Set<string>();
  private emitTimer?: NodeJS.Timeout;
  private lastFocusRefresh = 0;
  private backgroundTimer?: NodeJS.Timeout;
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
      watcher.onDidChange(uri => this.onFileEvent(uri, false)),
      watcher.onDidCreate(uri => this.onFileEvent(uri, true)),
      watcher.onDidDelete(uri => this.onFileEvent(uri, true)),
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
    clearInterval(this.backgroundTimer);
  }

  // ---- Queries ------------------------------------------------------------

  all(): RepoEntry[] {
    return [...this.repos.values()];
  }

  get(root: string): RepoEntry | undefined {
    return this.repos.get(root);
  }

  /** The innermost repo that contains `fsPath` (or is `fsPath`). */
  repoContaining(fsPath: string): RepoEntry | undefined {
    for (const root of this.rootsByLength) {
      if (isAtOrInside(fsPath, root)) return this.repos.get(root);
    }
    return undefined;
  }

  /** Repos strictly below `dir`. */
  reposUnder(dir: string): RepoEntry[] {
    return this.all().filter(r => isInside(r.root, dir));
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
    const result = await discoverRepos(roots, this.discoveryOptions());

    const found = new Set(result.repos.map(r => r.root));
    for (const root of this.repos.keys()) {
      if (!found.has(root)) this.repos.delete(root);
    }
    const added: string[] = [];
    for (const repo of result.repos) {
      if (!this.repos.has(repo.root)) {
        this.repos.set(repo.root, this.newEntry(repo.root, repo.isSubmodule));
        added.push(repo.root);
      }
    }
    this.scanned = new Set(result.scannedDirs);
    this.reindex();
    this.log.appendLine(
      `Found ${this.repos.size} repos in ${result.scannedDirs.length} folders (${Date.now() - started} ms)`,
    );

    await this.readCheapStates(added);
    this._onDidDiscover.fire();
    for (const root of added) this.requestStatus(root, Priority.Background);
  }

  /** Searches one folder that was past the depth limit. */
  async scanFolder(dir: string): Promise<void> {
    const result = await discoverRepos([dir], this.discoveryOptions());
    const added = result.repos.filter(r => !this.repos.has(r.root));
    for (const repo of added) this.repos.set(repo.root, this.newEntry(repo.root, repo.isSubmodule));
    result.scannedDirs.forEach(d => this.scanned.add(d));
    this.reindex();
    await this.readCheapStates(added.map(r => r.root));
    this._onDidDiscover.fire();
    for (const repo of added) this.requestStatus(repo.root, Priority.User);
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
    this.rootsByLength = [...this.repos.keys()].sort((a, b) => b.length - a.length);
    void vscode.commands.executeCommand(
      'setContext',
      'multiGitExplorer.repoPaths',
      Object.fromEntries([...this.repos.keys()].map(root => [root, true])),
    );
  }

  private async readCheapStates(roots: string[]): Promise<void> {
    await runPool(roots, CHEAP_READ_CONCURRENCY, async root => {
      const entry = this.repos.get(root);
      if (!entry) return;
      entry.cheap = await readCheapState(root);
      entry.view = this.describe(entry);
    });
  }

  // ---- Refreshing ---------------------------------------------------------

  /** Asks for a status check unless one was already asked for. Cheap to call often. */
  requestStatus(root: string, priority: number): void {
    const entry = this.repos.get(root);
    if (!entry) return;
    if (entry.requested && !this.queue.has(root)) return;
    entry.requested = true;
    this.queue.enqueue(root, priority, () => this.check(root));
  }

  /** Re-reads a repo, even if nothing seems to have changed. */
  refresh(root: string, priority: number = Priority.User): void {
    const entry = this.repos.get(root);
    if (!entry) return;
    entry.requested = true;
    this.queue.enqueue(root, priority, () => this.check(root));
  }

  refreshAll(priority: number = Priority.Background): void {
    const active = this.activeRepo();
    for (const root of this.repos.keys()) {
      this.refresh(root, root === active?.root ? Priority.Active : priority);
    }
  }

  /** The repo of the file in the active editor. */
  activeRepo(): RepoEntry | undefined {
    const uri = vscode.window.activeTextEditor?.document.uri;
    return uri?.scheme === 'file' ? this.repoContaining(uri.fsPath) : undefined;
  }

  private async check(root: string): Promise<void> {
    const entry = this.repos.get(root);
    if (!entry) return;
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
      entry.error = error instanceof Error ? error.message : String(error);
      entry.cheap = await readCheapState(root).catch(() => entry.cheap);
      this.log.appendLine(`${root}: ${entry.error}`);
    }
    entry.view = this.describe(entry);
    this.markChanged(root);
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

  private onFileEvent(uri: vscode.Uri, structural: boolean): void {
    if (uri.scheme !== 'file') return;
    const fsPath = uri.fsPath;
    const marker = `${path.sep}.git${path.sep}`;
    const gitIndex = fsPath.indexOf(marker);

    if (gitIndex >= 0) {
      const root = fsPath.slice(0, gitIndex);
      const inside = fsPath.slice(gitIndex + marker.length).split(path.sep)[0];
      if (this.repos.has(root) && RELEVANT_GIT_FILES.test(inside)) this.scheduleRefresh(root);
      return;
    }

    if (structural) {
      const parent = path.dirname(fsPath);
      this._onDidChangeFolder.fire(parent);
      // A new or removed .git folder means a repo appeared or went away.
      if (path.basename(fsPath) === '.git' && (this.scanned.has(parent) || this.repos.has(parent))) {
        void this.discover();
        return;
      }
    }
    const repo = this.repoContaining(fsPath);
    if (repo) this.scheduleRefresh(repo.root);
  }

  private onWindowFocus(): void {
    if (!config().get('refreshOnFocus', true)) return;
    const now = Date.now();
    if (now - this.lastFocusRefresh < FOCUS_THROTTLE_MS) return;
    this.lastFocusRefresh = now;
    this.refreshAll(Priority.Background);
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
      this.backgroundTimer = setInterval(() => this.refreshAll(Priority.Background), minutes * 60_000);
    }
  }
}
