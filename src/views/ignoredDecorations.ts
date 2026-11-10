import * as vscode from 'vscode';
import { checkIgnore } from '../core/git';
import { Limiter } from '../core/queue';
import type { RepoStore } from '../store';
import { gitPath } from '../workspace';
import { affectsExplorerDecorations, asFilesTreeShows, isFilesTreeUri } from './viewUri';

const DEBOUNCE_MS = 500;
/**
 * Repos checked at the same time, each with one git process, across all
 * batches, so a tall screen of many repos doesn't start dozens at once.
 */
export const IGNORE_CONCURRENCY = 4;
const DECORATION = new vscode.FileDecoration(undefined, undefined, new vscode.ThemeColor('gitDecoration.ignoredResourceForeground'));

interface Pending {
  promise: Promise<vscode.FileDecoration | undefined>;
  resolve: (decoration: vscode.FileDecoration | undefined) => void;
}

/**
 * Dims files that `.gitignore` ignores, as VS Code's git extension does in the
 * built-in Explorer (its GitIgnoreDecorationProvider): rows asked for are
 * collected per repo for half a second and checked with one
 * `git check-ignore`, the color is `gitDecoration.ignoredResourceForeground`,
 * and it follows `git.decorations.enabled`. Each row is checked in the
 * innermost repo holding it, so nested repos aren't dimmed by the outer one.
 */
export class IgnoredDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;
  private queue = new Map<string, Map<string, Pending>>();
  private timer?: NodeJS.Timeout;
  private readonly limiter = new Limiter(IGNORE_CONCURRENCY);
  private readonly disposables: vscode.Disposable[];

  constructor(
    private readonly store: RepoStore,
    private readonly check: typeof checkIgnore = checkIgnore,
  ) {
    const refresh = () => this._onDidChange.fire(undefined);
    this.disposables = [
      this._onDidChange,
      vscode.workspace.onDidSaveTextDocument(doc => {
        if (/\.gitignore$|\.git\/info\/exclude$/.test(doc.uri.path)) refresh();
      }),
      store.onDidDiscover(refresh),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('git.decorations.enabled') || affectsExplorerDecorations(e)) refresh();
      }),
    ];
  }

  dispose(): void {
    clearTimeout(this.timer);
    // Repos waiting their turn are answered as not ignored, without running git.
    this.limiter.clear();
    for (const pending of this.queue.values()) for (const p of pending.values()) p.resolve(undefined);
    this.queue.clear();
    this.disposables.forEach(d => d.dispose());
  }

  provideFileDecoration(uri: vscode.Uri): Promise<vscode.FileDecoration | undefined> | undefined {
    if (!isFilesTreeUri(uri)) return undefined;
    if (vscode.workspace.getConfiguration('git').get<boolean>('decorations.enabled') === false) return undefined;
    // The dimming is only a color, which `explorer.decorations.colors` turns off.
    if (!asFilesTreeShows(uri, DECORATION)) return undefined;
    const fsPath = uri.fsPath;
    const repo = this.store.get(fsPath) ?? this.store.repoContaining(fsPath);
    // A repo's own folder is never ignored by itself, so don't ask.
    if (!repo || repo.root === fsPath) return undefined;
    let pending = this.queue.get(repo.root);
    if (!pending) this.queue.set(repo.root, (pending = new Map()));
    let item = pending.get(fsPath);
    if (!item) {
      let resolve!: Pending['resolve'];
      const promise = new Promise<vscode.FileDecoration | undefined>(r => (resolve = r));
      item = { promise, resolve };
      pending.set(fsPath, item);
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.checkQueued(), DEBOUNCE_MS);
    return item.promise;
  }

  private checkQueued(): void {
    const queue = this.queue;
    this.queue = new Map();
    for (const [root, pending] of queue) {
      void this.limiter
        .run(() => this.check(root, [...pending.keys()], { gitPath: gitPath() }))
        .catch(() => new Set<string>())
        .then(ignored => {
          for (const [fsPath, p] of pending) p.resolve(ignored.has(fsPath) ? DECORATION : undefined);
        });
    }
  }
}
