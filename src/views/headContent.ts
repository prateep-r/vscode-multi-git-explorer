import * as vscode from 'vscode';
import { runGit } from '../core/git';

/** Read-only documents holding a file as it is in HEAD, for the left side of diffs. */
export const HEAD_SCHEME = 'multi-repo-explorer-head';

/**
 * A URI for `relPath` at HEAD in the repo at `root`. It keeps the real file's
 * path so the diff editor shows the right name and language. With no
 * `relPath` the document is empty, for files that are new or deleted.
 */
export function headUri(fileUri: vscode.Uri, root: string, relPath: string | undefined): vscode.Uri {
  return fileUri.with({ scheme: HEAD_SCHEME, query: JSON.stringify({ root, path: relPath ?? null }) });
}

export class HeadContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { root, path } = JSON.parse(uri.query) as { root: string; path: string | null };
    if (!path) return '';
    const gitPath = vscode.workspace.getConfiguration('git').get<string | string[]>('path');
    try {
      return await runGit(root, ['show', `HEAD:${path}`], {
        gitPath: (Array.isArray(gitPath) ? gitPath[0] : gitPath) || undefined,
      });
    } catch {
      return '';
    }
  }
}
