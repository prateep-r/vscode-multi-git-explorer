import * as path from 'path';
import * as vscode from 'vscode';
import { confirmsUndo, UndoStack, type FileOpKind } from './core/undo';

/** Files up to this size are kept for undoing a delete, as in the built-in Explorer (MAX_UNDO_FILE_SIZE). */
export const MAX_UNDO_FILE_SIZE = 5_000_000;

export type FileOp =
  | { kind: 'rename' | 'move'; label: string; moves: { from: string; to: string }[] }
  | { kind: 'create' | 'paste' | 'import'; label: string; created: { path: string; isDir: boolean; source?: string }[] }
  | { kind: 'delete'; label: string; deleted: { path: string; isDir: boolean; content?: Uint8Array }[]; permanently: boolean };

/**
 * Undo and redo for the file tree's operations, with Cmd/Ctrl+Z and
 * Cmd+Shift+Z / Ctrl+Y while it has focus, like the built-in Explorer. VS Code
 * keeps extensions' file edits on its own stack only for the editors of those
 * files, so the tree keeps its own. As in the built-in Explorer: undoing a
 * delete restores files of up to 5 MB and recreates folders empty, it follows
 * `explorer.enableUndo` and `explorer.confirmUndo`, and redo doesn't ask.
 */
export class FileUndo {
  private readonly stack = new UndoStack<FileOp>();

  constructor(private readonly afterChange: (changed: { uri: vscode.Uri; isDir: boolean }[]) => Promise<void>) {
    this.updateContext();
  }

  record(op: FileOp): void {
    this.stack.record(op);
    this.updateContext();
  }

  async undo(): Promise<void> {
    const op = this.stack.takeUndo();
    if (!op) return;
    const level = vscode.workspace.getConfiguration('explorer').get('confirmUndo');
    if (confirmsUndo(op.kind as FileOpKind, level)) {
      const choice = await vscode.window.showInformationMessage(`Would you like to undo '${op.label}'?`, { modal: true }, 'Yes');
      if (choice !== 'Yes') {
        this.stack.cancelUndo(op);
        return;
      }
    }
    await this.run(op, 'undo');
  }

  async redo(): Promise<void> {
    const op = this.stack.takeRedo();
    if (op) await this.run(op, 'redo');
  }

  private async run(op: FileOp, direction: 'undo' | 'redo'): Promise<void> {
    try {
      if (!(await this.matchesDisk(op, direction))) {
        void vscode.window.showErrorMessage(`Couldn't ${direction} '${op.label}', as the files have changed since.`);
        return;
      }
      await (direction === 'undo' ? this.applyUndo(op) : this.applyRedo(op));
      if (direction === 'undo') this.stack.undoneOp(op);
      else this.stack.redoneOp(op);
    } catch (error) {
      void vscode.window.showErrorMessage(`Couldn't ${direction} '${op.label}': ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.updateContext();
    }
  }

  /** Whether the disk is still as the operation left it (for undo) or found it (for redo). */
  private async matchesDisk(op: FileOp, direction: 'undo' | 'redo'): Promise<boolean> {
    const undo = direction === 'undo';
    switch (op.kind) {
      case 'rename':
      case 'move':
        return everyAsync(op.moves, async m => (await exists(undo ? m.to : m.from)) && !(await exists(undo ? m.from : m.to)));
      case 'create':
        return everyAsync(op.created, async c => (await exists(c.path)) === undo);
      case 'paste':
      case 'import':
        return undo
          ? everyAsync(op.created, c => exists(c.path))
          : everyAsync(op.created, async c => !!c.source && (await exists(c.source)) && (op.kind === 'import' || !(await exists(c.path))));
      case 'delete':
        return everyAsync(op.deleted, async d => (await exists(d.path)) !== undo);
    }
  }

  private async applyUndo(op: FileOp): Promise<void> {
    switch (op.kind) {
      case 'rename':
      case 'move':
        return this.rename([...op.moves].reverse().map(m => ({ from: m.to, to: m.from })));
      case 'create':
      case 'paste':
      case 'import':
        return this.remove(op.created, false);
      case 'delete':
        for (const d of op.deleted) {
          const uri = vscode.Uri.file(d.path);
          if (d.isDir) await vscode.workspace.fs.createDirectory(uri);
          else await vscode.workspace.fs.writeFile(uri, d.content ?? new Uint8Array());
        }
        await this.afterChange(op.deleted.map(d => ({ uri: vscode.Uri.file(d.path), isDir: d.isDir })));
        return;
    }
  }

  private async applyRedo(op: FileOp): Promise<void> {
    switch (op.kind) {
      case 'rename':
      case 'move':
        return this.rename(op.moves);
      case 'create':
        for (const c of op.created) {
          const uri = vscode.Uri.file(c.path);
          if (c.isDir) await vscode.workspace.fs.createDirectory(uri);
          else await vscode.workspace.fs.writeFile(uri, new Uint8Array());
        }
        await this.afterChange(op.created.map(c => ({ uri: vscode.Uri.file(c.path), isDir: c.isDir })));
        return;
      case 'paste':
      case 'import':
        for (const c of op.created) {
          await vscode.workspace.fs.copy(vscode.Uri.file(c.source!), vscode.Uri.file(c.path), { overwrite: op.kind === 'import' });
        }
        await this.afterChange(op.created.map(c => ({ uri: vscode.Uri.file(c.path), isDir: c.isDir })));
        return;
      case 'delete':
        return this.remove(op.deleted, op.permanently);
    }
  }

  /** Moves through VS Code, so open editors follow, as for the operation itself. */
  private async rename(moves: { from: string; to: string }[]): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    for (const m of moves) edit.renameFile(vscode.Uri.file(m.from), vscode.Uri.file(m.to));
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error('VS Code refused the move');
    const moved = await Promise.all(
      moves.map(async m => ({
        uri: vscode.Uri.file(m.to),
        isDir: ((await vscode.workspace.fs.stat(vscode.Uri.file(m.to)).then(s => s.type, () => 0)) & vscode.FileType.Directory) !== 0,
      })),
    );
    await this.afterChange(moved);
  }

  private async remove(items: { path: string; isDir: boolean }[], permanently: boolean): Promise<void> {
    const useTrash = !permanently && vscode.workspace.getConfiguration('files').get('enableTrash', true);
    for (const item of items) await vscode.workspace.fs.delete(vscode.Uri.file(item.path), { recursive: true, useTrash });
    await this.afterChange(items.map(i => ({ uri: vscode.Uri.file(i.path), isDir: i.isDir })));
  }

  private updateContext(): void {
    void vscode.commands.executeCommand('setContext', 'multiGitExplorer.canUndo', this.stack.canUndo);
    void vscode.commands.executeCommand('setContext', 'multiGitExplorer.canRedo', this.stack.canRedo);
  }
}

/** What a delete keeps for undoing it: files up to 5 MB with their contents, folders as empty folders. */
export async function snapshotForUndo(items: readonly { uri: vscode.Uri; isDir: boolean }[]): Promise<{ path: string; isDir: boolean; content?: Uint8Array }[]> {
  const kept: { path: string; isDir: boolean; content?: Uint8Array }[] = [];
  for (const item of items) {
    if (item.isDir) {
      kept.push({ path: item.uri.fsPath, isDir: true });
      continue;
    }
    try {
      const stat = await vscode.workspace.fs.stat(item.uri);
      if (stat.size <= MAX_UNDO_FILE_SIZE) kept.push({ path: item.uri.fsPath, isDir: false, content: await vscode.workspace.fs.readFile(item.uri) });
    } catch {
      // Gone already, so there's nothing to keep.
    }
  }
  return kept;
}

export function names(paths: readonly string[]): string[] {
  return paths.map(p => path.basename(p));
}

async function exists(fsPath: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(fsPath));
    return true;
  } catch {
    return false;
  }
}

async function everyAsync<T>(items: readonly T[], check: (item: T) => Promise<boolean>): Promise<boolean> {
  for (const item of items) if (!(await check(item))) return false;
  return true;
}
