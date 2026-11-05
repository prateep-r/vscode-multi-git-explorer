// The parts of the built-in Git extension's API (vscode.git) that Multi-Repo Explorer uses.
// Full definition: https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts

import type { Uri } from 'vscode';

export interface GitExtension {
  getAPI(version: 1): GitAPI;
}

export interface GitAPI {
  getRepository(uri: Uri): GitRepository | null;
  openRepository(root: Uri): Promise<GitRepository | null>;
  toGitUri(uri: Uri, ref: string): Uri;
}

export interface GitRepository {
  readonly rootUri: Uri;
  readonly state: {
    readonly indexChanges: GitChange[];
    readonly workingTreeChanges: GitChange[];
    readonly mergeChanges: GitChange[];
    readonly untrackedChanges?: GitChange[];
  };
  status(): Promise<void>;
}

export interface GitChange {
  readonly uri: Uri;
  readonly originalUri: Uri;
  readonly status: GitStatus;
}

export const enum GitStatus {
  INDEX_MODIFIED,
  INDEX_ADDED,
  INDEX_DELETED,
  INDEX_RENAMED,
  INDEX_COPIED,
  MODIFIED,
  DELETED,
  UNTRACKED,
  IGNORED,
  INTENT_TO_ADD,
}
