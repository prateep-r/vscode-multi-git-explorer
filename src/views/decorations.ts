import * as vscode from 'vscode';
import { Priority } from '../core/queue';
import type { StateKind } from '../core/state';
import type { RepoStore } from '../store';

const KIND_COLOR: Partial<Record<StateKind, string>> = {
  error: 'multiRepoGit.errorForeground',
  conflict: 'multiRepoGit.conflictForeground',
  operation: 'multiRepoGit.conflictForeground',
  dirty: 'multiRepoGit.dirtyForeground',
  detached: 'multiRepoGit.dirtyForeground',
  diverged: 'multiRepoGit.behindForeground',
  behind: 'multiRepoGit.behindForeground',
  ahead: 'multiRepoGit.aheadForeground',
  noUpstream: 'multiRepoGit.aheadForeground',
  pending: 'multiRepoGit.pendingForeground',
};

/** Kinds whose color should also tint the parent folders, like git does for changed files. */
const PROPAGATING_KINDS = new Set<StateKind>(['error', 'conflict', 'operation', 'dirty', 'detached', 'diverged', 'ahead', 'noUpstream', 'behind']);

/**
 * Adds a color, a short badge and a tooltip to every repo folder, in the
 * built-in Explorer and in our own views. VS Code only asks for folders that
 * are on screen, so this is also how visible repos get checked first.
 */
export class RepoDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;
  private readonly disposables: vscode.Disposable[];

  constructor(private readonly store: RepoStore) {
    this.disposables = [
      store.onDidChangeRepos(roots => this._onDidChange.fire(roots.map(root => vscode.Uri.file(root)))),
      store.onDidDiscover(() => this._onDidChange.fire(undefined)),
      this._onDidChange,
    ];
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'file') return undefined;
    const repo = this.store.get(uri.fsPath);
    if (!repo) return undefined;
    this.store.requestStatus(repo.root, Priority.Visible);

    const { view } = repo;
    const color = KIND_COLOR[view.kind];
    const decoration = new vscode.FileDecoration(view.badge, view.tooltip, color ? new vscode.ThemeColor(color) : undefined);
    decoration.propagate = PROPAGATING_KINDS.has(view.kind);
    return decoration;
  }
}
