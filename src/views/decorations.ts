import * as path from 'path';
import * as vscode from 'vscode';
import type { ChangeLetter, ChangedFile } from '../core/porcelain';
import { Priority } from '../core/queue';
import type { StateKind } from '../core/state';
import type { RepoEntry, RepoStore } from '../store';
import { VIEW_SCHEME, toViewUri } from './viewUri';

const KIND_COLOR: Partial<Record<StateKind, string>> = {
  error: 'multiRepoExplorer.errorForeground',
  conflict: 'multiRepoExplorer.conflictForeground',
  operation: 'multiRepoExplorer.conflictForeground',
  dirty: 'multiRepoExplorer.dirtyForeground',
  detached: 'multiRepoExplorer.dirtyForeground',
  diverged: 'multiRepoExplorer.behindForeground',
  behind: 'multiRepoExplorer.behindForeground',
  ahead: 'multiRepoExplorer.aheadForeground',
  noUpstream: 'multiRepoExplorer.aheadForeground',
  pending: 'multiRepoExplorer.pendingForeground',
};

/** Kinds whose color should also tint the parent folders, like git does for changed files. */
const PROPAGATING_KINDS = new Set<StateKind>(['error', 'conflict', 'operation', 'dirty', 'detached', 'diverged', 'ahead', 'noUpstream', 'behind']);

const LETTER_COLOR: Record<ChangeLetter, string> = {
  M: 'gitDecoration.modifiedResourceForeground',
  A: 'gitDecoration.addedResourceForeground',
  D: 'gitDecoration.deletedResourceForeground',
  R: 'gitDecoration.renamedResourceForeground',
  U: 'gitDecoration.untrackedResourceForeground',
  '!': 'gitDecoration.conflictingResourceForeground',
};

const LETTER_TOOLTIP: Record<ChangeLetter, string> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  R: 'Renamed',
  U: 'Untracked',
  '!': 'Conflict',
};

function decorateExplorer(): boolean {
  return vscode.workspace.getConfiguration('multiRepoExplorer').get('decorateExplorer', false);
}

/**
 * Colors, short badges and tooltips for repos and changed files in our views,
 * and, when `multiRepoExplorer.decorateExplorer` is on, for repo folders in the
 * built-in Explorer. VS Code only asks for rows that are on screen, so this is
 * also how visible repos get checked first.
 */
export class RepoDecorationProvider implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;
  /** Changed-file URIs decorated last time, per repo, so removed changes get cleared. */
  private readonly decoratedFiles = new Map<string, vscode.Uri[]>();
  private readonly disposables: vscode.Disposable[];

  constructor(private readonly store: RepoStore) {
    this.disposables = [
      store.onDidChangeRepos(roots => this._onDidChange.fire(roots.flatMap(root => this.urisFor(root)))),
      store.onDidDiscover(() => this._onDidChange.fire(undefined)),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('multiRepoExplorer.decorateExplorer')) this._onDidChange.fire(undefined);
      }),
      this._onDidChange,
    ];
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme === VIEW_SCHEME) return this.forRepo(uri.fsPath) ?? this.forChange(uri.fsPath);
    if (uri.scheme === 'file' && decorateExplorer()) return this.forRepo(uri.fsPath);
    return undefined;
  }

  private forRepo(fsPath: string): vscode.FileDecoration | undefined {
    const repo = this.store.get(fsPath);
    if (!repo) return undefined;
    this.store.requestStatus(repo.root, Priority.Visible);

    const { view } = repo;
    const color = KIND_COLOR[view.kind];
    const decoration = new vscode.FileDecoration(view.badge, view.tooltip, color ? new vscode.ThemeColor(color) : undefined);
    decoration.propagate = PROPAGATING_KINDS.has(view.kind);
    return decoration;
  }

  private forChange(fsPath: string): vscode.FileDecoration | undefined {
    const repo = this.store.repoContaining(fsPath);
    const change = repo && findChange(repo, fsPath);
    if (!change) return undefined;
    const decoration = new vscode.FileDecoration(
      change.letter,
      LETTER_TOOLTIP[change.letter] + (change.staged ? (change.unstaged ? ', partly staged' : ', staged') : ''),
      new vscode.ThemeColor(LETTER_COLOR[change.letter]),
    );
    decoration.propagate = true;
    return decoration;
  }

  private urisFor(root: string): vscode.Uri[] {
    const repo = this.store.get(root);
    const files = [...(repo?.changes?.keys() ?? [])].map(rel => toViewUri(path.join(root, rel.replace(/\/$/, ''))));
    const uris = [toViewUri(root), ...files, ...(this.decoratedFiles.get(root) ?? [])];
    this.decoratedFiles.set(root, files);
    if (decorateExplorer()) uris.push(vscode.Uri.file(root));
    return uris;
  }
}

/** The change recorded for a path, including files inside an untracked folder. */
function findChange(repo: RepoEntry, fsPath: string): ChangedFile | undefined {
  if (!repo.changes || fsPath === repo.root) return undefined;
  let rel = path.relative(repo.root, fsPath).split(path.sep).join('/');
  const direct = repo.changes.get(rel) ?? repo.changes.get(`${rel}/`);
  if (direct) return direct;
  while (rel.includes('/')) {
    rel = rel.slice(0, rel.lastIndexOf('/'));
    const folder = repo.changes.get(`${rel}/`);
    if (folder) return folder;
  }
  return undefined;
}
