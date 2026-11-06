/** The file operations of the file tree that can be undone, as in the built-in Explorer. */
export type FileOpKind = 'create' | 'delete' | 'rename' | 'move' | 'paste' | 'import';

/**
 * Whether undoing asks first, as the built-in Explorer decides with
 * `explorer.confirmUndo` (VS Code 1.145, fileActions.ts): creating always
 * asks, renames and moves only when "verbose", pastes and imports unless
 * "light", and deletes never.
 */
export function confirmsUndo(kind: FileOpKind, level: unknown): boolean {
  switch (kind) {
    case 'create':
      return true;
    case 'rename':
    case 'move':
      return level === 'verbose';
    case 'paste':
    case 'import':
      return level !== 'light';
    case 'delete':
      return false;
  }
}

/** The name an operation goes by in the undo question, worded as the built-in Explorer words it. */
export function undoLabel(kind: FileOpKind, names: readonly string[], newName?: string): string {
  const many = names.length > 1;
  switch (kind) {
    case 'create':
      return `Create ${names[0]}`;
    case 'delete':
      return many ? `Delete ${names.length} files` : `Delete ${names[0]}`;
    case 'rename':
      return `Rename ${names[0]} to ${newName}`;
    case 'move':
      return many ? `Move ${names.length} files` : `Move ${names[0]}`;
    case 'paste':
      return many ? `Paste ${names.length} files` : `Paste ${names[0]}`;
    case 'import':
      return many ? `Import ${names.length} resources` : `Import ${names[0]}`;
  }
}

/** Done and undone operations: undoing moves one from done to undone, redoing back. A new operation clears undone. */
export class UndoStack<T> {
  private done: T[] = [];
  private undone: T[] = [];

  record(op: T): void {
    this.done.push(op);
    this.undone = [];
  }

  get canUndo(): boolean {
    return this.done.length > 0;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
  }

  /** The last done operation, taken off the stack. Put it back with `undone` or `cancelUndo`. */
  takeUndo(): T | undefined {
    return this.done.pop();
  }

  takeRedo(): T | undefined {
    return this.undone.pop();
  }

  undoneOp(op: T): void {
    this.undone.push(op);
  }

  redoneOp(op: T): void {
    this.done.push(op);
  }

  /** Puts back an operation the user chose not to undo. */
  cancelUndo(op: T): void {
    this.done.push(op);
  }

  cancelRedo(op: T): void {
    this.undone.push(op);
  }
}
