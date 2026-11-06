import * as vscode from 'vscode';
import { checkIgnore } from '../core/git';
import type { RepoStore } from '../store';
import { gitPath } from '../workspace';
import { VIEW_SCHEME } from './viewUri';

const DEBOUNCE_MS = 500;
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
  private readonly disposables: vscode.Disposable[];

  constructor(private readonly store: RepoStore) {
    const refresh = () => this._onDidChange.fire(undefined);
    this.disposables = [
      this._onDidChange,
      vscode.workspace.onDidSaveTextDocument(doc => {
        if (/\.gitignore$|\.git\/info\/exclude$/.test(doc.uri.path)) refresh();
      }),
      store.onDidDiscover(refresh),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('git.decorations.enabled')) refresh();
      }),
    ];
  }

  dispose(): void {
    clearTimeout(this.timer);
    for (const pending of this.queue.values()) for (const p of pending.values()) p.resolve(undefined);
    this.queue.clear();
    this.disposables.forEach(d => d.dispose());
  }

  provideFileDecoration(uri: vscode.Uri): Promise<vscode.FileDecoration | undefined> | undefined {
    if (uri.scheme !== VIEW_SCHEME) return undefined;
    if (vscode.workspace.getConfiguration('git').get<boolean>('decorations.enabled') === false) return undefined;
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
      checkIgnore(root, [...pending.keys()], { gitPath: gitPath() }).then(
        ignored => {
          for (const [fsPath, p] of pending) p.resolve(ignored.has(fsPath) ? DECORATION : undefined);
        },
        () => {
          for (const p of pending.values()) p.resolve(undefined);
        },
      );
    }
  }
}
