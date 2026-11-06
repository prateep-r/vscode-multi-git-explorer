import * as path from 'path';
import * as vscode from 'vscode';
import { checkNewName, checkNewPath, copyName } from './core/fileNames';
import { isAtOrInside } from './core/paths';
import type { RepoStore } from './store';
import type { ExplorerNode, RepoExplorerProvider } from './views/repoExplorer';
import { toViewUri } from './views/viewUri';
import { folderOf, isKeyboard, isWorkspaceFolder, localFolders, onDisk, pickRows } from './workspace';

/**
 * Commands that change files from the Repo Explorer, like the built-in
 * Explorer's: New File, New Folder, Rename, Delete, Cut, Copy, Paste, and
 * moving by drag and drop. Tree views can't edit a name in place, so names
 * are asked for in an input box.
 */
export function registerFileCommands(
  files: FileOperations,
  explorer: RepoExplorerProvider,
  tree: vscode.TreeView<ExplorerNode>,
): vscode.Disposable[] {
  // Deleted files, listed while filtering, can't be renamed, moved or copied.
  // The menu hides those commands for them, but keyboard shortcuts still reach them.
  // Keyboard shortcuts act on the focused row, or the selection it is part of.
  const picked = async (clicked?: ExplorerNode | { keyboard: true }, selected?: readonly ExplorerNode[]) =>
    (isKeyboard(clicked) ? await explorer.keyboardRows() : pickRows(clicked, selected ?? tree.selection, n => n.uri.fsPath)).filter(
      onDisk,
    );
  // Cut, copy and delete take the files nested under a closed nest parent along.
  const pickedWithNested = async (clicked?: ExplorerNode | { keyboard: true }, selected?: readonly ExplorerNode[]) =>
    explorer.withNestedFiles(await picked(clicked, selected));

  const create = async (kind: 'file' | 'folder', target?: ExplorerNode, name?: unknown) => {
    const parent = target ? folderOf(target) : explorer.selectedFolder();
    if (!parent) return;
    const where = vscode.workspace.asRelativePath(parent, true);
    const entered =
      typeof name === 'string'
        ? name
        : await vscode.window.showInputBox({
            title: kind === 'file' ? 'New File' : 'New Folder',
            prompt: `In ${where === parent.fsPath ? path.basename(parent.fsPath) : where}/`,
            placeHolder: kind === 'file' ? 'name.ts, or a path like src/utils/date.ts' : 'name, or a path like src/utils',
            validateInput: value => validate(parent, value),
          });
    if (!entered?.trim()) return;
    const problem = kind === 'file' && /[\\/]$/.test(entered.trim()) ? 'Enter a file name after the last "/".' : await validate(parent, entered);
    if (problem) {
      void vscode.window.showErrorMessage(problem);
      return;
    }

    const uri = vscode.Uri.file(path.join(parent.fsPath, entered.trim()));
    if (kind === 'folder') {
      try {
        await vscode.workspace.fs.createDirectory(uri);
      } catch (error) {
        void vscode.window.showErrorMessage(`Couldn't create ${entered.trim()}: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    } else {
      const edit = new vscode.WorkspaceEdit();
      edit.createFile(uri, { ignoreIfExists: false });
      if (!(await vscode.workspace.applyEdit(edit))) {
        void vscode.window.showErrorMessage(`Couldn't create ${entered.trim()}.`);
        return;
      }
      await vscode.window.showTextDocument(uri, { preview: false });
    }
    await explorer.reveal(uri, kind === 'folder');
  };

  return [
    vscode.commands.registerCommand('multiGitExplorer.newFile', (target?: ExplorerNode, name?: unknown) => create('file', target, name)),
    vscode.commands.registerCommand('multiGitExplorer.newFolder', (target?: ExplorerNode, name?: unknown) => create('folder', target, name)),
    vscode.commands.registerCommand('multiGitExplorer.rename', async (clicked?: ExplorerNode | { keyboard: true }, newName?: unknown) => {
      // Renames one row, like the built-in Explorer; a name may be passed instead of asked for.
      const row = isKeyboard(clicked) ? await explorer.focusedRow() : (clicked ?? tree.selection[0]);
      const node = row && !isWorkspaceFolder(row.uri.fsPath) ? (await picked(row))[0] : undefined;
      if (node) return files.rename(node, typeof newName === 'string' ? newName : undefined);
      // Enter renames on macOS. On a row that can't be renamed it opens or expands the row, as the built-in Explorer's Enter does.
      if (isKeyboard(clicked)) return vscode.commands.executeCommand('list.select');
      return undefined;
    }),
    vscode.commands.registerCommand('multiGitExplorer.delete', async (clicked?: ExplorerNode | { keyboard: true }, selected?: ExplorerNode[]) =>
      files.delete(await pickedWithNested(clicked, selected)),
    ),
    vscode.commands.registerCommand(
      'multiGitExplorer.deletePermanently',
      async (clicked?: ExplorerNode | { keyboard: true }, selected?: ExplorerNode[]) =>
        files.delete(await pickedWithNested(clicked, selected), { permanently: true }),
    ),
    vscode.commands.registerCommand('multiGitExplorer.cut', async (clicked?: ExplorerNode | { keyboard: true }, selected?: ExplorerNode[]) =>
      files.setClipboard(await pickedWithNested(clicked, selected), true),
    ),
    vscode.commands.registerCommand('multiGitExplorer.copy', async (clicked?: ExplorerNode | { keyboard: true }, selected?: ExplorerNode[]) =>
      files.setClipboard(await pickedWithNested(clicked, selected), false),
    ),
    // Escape cancels a cut when the focused row is cut; otherwise it clears the selection, as in any tree.
    vscode.commands.registerCommand('multiGitExplorer.cancelCut', async () => {
      const focused = await explorer.focusedRow();
      if (focused && files.isCut(focused.uri.fsPath)) files.cancelCut();
      else await vscode.commands.executeCommand('list.clear');
    }),
    vscode.commands.registerCommand('multiGitExplorer.paste', async (clicked?: ExplorerNode | { keyboard: true }) => {
      const row = isKeyboard(clicked) ? await explorer.focusedRow() : clicked;
      const target = row ? folderOf(row) : explorer.selectedFolder();
      return target ? files.paste(target) : undefined;
    }),
  ];
}

/** Drops rows inside other picked folders, so a folder and its contents aren't handled twice. */
function outermost(nodes: readonly ExplorerNode[]): ExplorerNode[] {
  const unique = [...new Map(nodes.map(n => [n.uri.fsPath, n])).values()];
  return unique.filter(n => !unique.some(o => o !== n && o.isDir && isAtOrInside(n.uri.fsPath, o.uri.fsPath)));
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

interface Item {
  uri: vscode.Uri;
  isDir: boolean;
}

interface Clipboard {
  items: Item[];
  cut: boolean;
}

interface Move {
  from: vscode.Uri;
  to: vscode.Uri;
  overwrite: boolean;
}

/** The tree's mime type, which VS Code derives from the view id. */
const TREE_MIME = 'application/vnd.code.tree.multigitexplorer.explorer';

/** File changes made from the file tree; also its drag and drop controller. */
export class FileOperations implements vscode.Disposable {
  private clipboard?: Clipboard;
  private readonly _onDidChangeCut = new vscode.EventEmitter<vscode.Uri[]>();
  /** Fires with the rows that became cut, or stopped being cut, as view URIs. */
  readonly onDidChangeCut = this._onDidChangeCut.event;

  constructor(
    private readonly store: RepoStore,
    private readonly explorer: RepoExplorerProvider,
  ) {}

  dispose(): void {
    this._onDidChangeCut.dispose();
    this.clipboard = undefined;
  }

  async rename(node: ExplorerNode, given?: string): Promise<void> {
    if (isWorkspaceFolder(node.uri.fsPath)) {
      void vscode.window.showWarningMessage('A workspace folder can’t be renamed here.');
      return;
    }
    const oldName = path.basename(node.uri.fsPath);
    const dir = path.dirname(node.uri.fsPath);
    const ext = path.extname(oldName);
    const check = async (value: string) => {
      const problem = checkNewName(value);
      if (problem || value === oldName) return problem;
      // Changing only the case is a rename of the same file on case-insensitive disks.
      if (value.toLowerCase() !== oldName.toLowerCase() && (await exists(vscode.Uri.file(path.join(dir, value))))) {
        return `${value} already exists here.`;
      }
      return undefined;
    };
    const newName =
      given ??
      (await vscode.window.showInputBox({
        title: `Rename ${oldName}`,
        value: oldName,
        // Select the name without its extension, like the built-in Explorer.
        valueSelection: [0, node.isDir || !ext || ext === oldName ? oldName.length : oldName.length - ext.length],
        validateInput: check,
      }));
    if (!newName || newName === oldName) return;
    const problem = await check(newName);
    if (problem) {
      void vscode.window.showErrorMessage(problem);
      return;
    }
    const target = vscode.Uri.file(path.join(dir, newName));
    if (await this.move([{ from: node.uri, to: target, overwrite: false }])) {
      await this.afterChange([node, { uri: target, isDir: node.isDir }]);
      await this.explorer.reveal(target, node.isDir);
    }
  }

  /** Deletes to the Trash when `files.enableTrash` is on, unless `permanently` (Shift+Delete in the built-in Explorer). */
  async delete(nodes: readonly ExplorerNode[], { permanently = false } = {}): Promise<void> {
    const targets = outermost(nodes).filter(n => !isWorkspaceFolder(n.uri.fsPath));
    if (targets.length === 0) return;
    const useTrash = !permanently && vscode.workspace.getConfiguration('files').get('enableTrash', true);
    if (vscode.workspace.getConfiguration('explorer').get('confirmDelete', true) || !useTrash) {
      const what = targets.length === 1 ? `'${path.basename(targets[0].uri.fsPath)}'` : `these ${targets.length} items`;
      const trash = process.platform === 'win32' ? 'Recycle Bin' : 'Trash';
      const unsaved = vscode.workspace.textDocuments.filter(
        d => d.isDirty && targets.some(t => isAtOrInside(d.uri.fsPath, t.uri.fsPath)),
      ).length;
      const detail = [
        targets.length > 1 ? targets.map(t => path.basename(t.uri.fsPath)).join('\n') : undefined,
        unsaved ? `${unsaved === 1 ? 'A file' : `${unsaved} files`} with unsaved changes will stay open, marked as deleted.` : undefined,
        useTrash ? `You can restore ${targets.length === 1 ? 'it' : 'them'} from the ${trash}.` : 'This can’t be undone.',
      ]
        .filter(Boolean)
        .join('\n\n');
      const button = useTrash ? `Move to ${trash}` : 'Delete';
      const choice = await vscode.window.showWarningMessage(
        `Are you sure you want to ${useTrash ? 'delete' : 'permanently delete'} ${what}?`,
        { modal: true, detail },
        button,
      );
      if (choice !== button) return;
    }
    const failed: string[] = [];
    for (const target of targets) {
      try {
        await vscode.workspace.fs.delete(target.uri, { recursive: true, useTrash });
      } catch (error) {
        failed.push(`${path.basename(target.uri.fsPath)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failed.length) void vscode.window.showErrorMessage(`Couldn't delete ${failed.join('; ')}`);
    await this.afterChange(targets);
  }

  /** Whether this exact row was cut and not pasted yet. Rows inside a cut folder aren't, as in the built-in Explorer. */
  isCut(fsPath: string): boolean {
    return !!this.clipboard?.cut && this.clipboard.items.some(i => i.uri.fsPath === fsPath);
  }

  /** Escape: forgets the cut items, so they can't be pasted. */
  cancelCut(): void {
    if (!this.clipboard?.cut) return;
    this.replaceClipboard(undefined);
    void vscode.commands.executeCommand('setContext', 'multiGitExplorer.canPaste', false);
  }

  private replaceClipboard(clipboard: Clipboard | undefined): void {
    const wasCut = this.clipboard?.cut ? this.clipboard.items : [];
    this.clipboard = clipboard;
    const nowCut = clipboard?.cut ? clipboard.items : [];
    void vscode.commands.executeCommand('setContext', 'multiGitExplorer.resourceCut', nowCut.length > 0);
    const changed = [...wasCut, ...nowCut].map(i => toViewUri(i.uri.fsPath));
    if (changed.length) this._onDidChangeCut.fire(changed);
  }

  async setClipboard(nodes: readonly ExplorerNode[], cut: boolean): Promise<void> {
    const items = outermost(nodes)
      .filter(n => !(cut && isWorkspaceFolder(n.uri.fsPath)))
      .map(n => ({ uri: n.uri, isDir: n.isDir }));
    if (items.length === 0) return;
    this.replaceClipboard({ items, cut });
    await vscode.commands.executeCommand('setContext', 'multiGitExplorer.canPaste', true);
    const what = items.length === 1 ? path.basename(items[0].uri.fsPath) : `${items.length} items`;
    vscode.window.setStatusBarMessage(`${cut ? 'Cut' : 'Copied'} ${what}. Paste into a folder in the file tree.`, 3000);
  }

  async paste(folder: vscode.Uri): Promise<void> {
    const clipboard = this.clipboard;
    if (!clipboard) return;
    const pasted: Item[] = [];
    if (clipboard.cut) {
      const moves = await this.planMoves(clipboard.items, folder);
      if (moves && (await this.move(moves))) {
        pasted.push(...moves.map(m => ({ uri: m.to, isDir: clipboard.items.find(i => i.uri.fsPath === m.from.fsPath)!.isDir })));
        // A cut can only be pasted once, like the built-in Explorer.
        this.replaceClipboard(undefined);
        void vscode.commands.executeCommand('setContext', 'multiGitExplorer.canPaste', false);
      }
    } else {
      for (const item of clipboard.items) {
        if (item.isDir && isAtOrInside(folder.fsPath, item.uri.fsPath)) {
          void vscode.window.showErrorMessage(`Can't paste ${path.basename(item.uri.fsPath)} into itself.`);
          continue;
        }
        const name = path.basename(item.uri.fsPath);
        let target = vscode.Uri.file(path.join(folder.fsPath, name));
        for (let n = 1; await exists(target); n++) target = vscode.Uri.file(path.join(folder.fsPath, copyName(name, item.isDir, n)));
        try {
          await vscode.workspace.fs.copy(item.uri, target, { overwrite: false });
          pasted.push({ uri: target, isDir: item.isDir });
        } catch (error) {
          void vscode.window.showErrorMessage(`Couldn't paste ${name}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    if (pasted.length === 0) return;
    await this.afterChange(clipboard.items);
    await this.explorer.reveal(pasted[pasted.length - 1].uri, pasted[pasted.length - 1].isDir);
  }

  /** Moves dragged rows into a folder, asking first unless `explorer.confirmDragAndDrop` is off. */
  async drop(nodes: readonly ExplorerNode[], folder: vscode.Uri): Promise<void> {
    const items = outermost(nodes).filter(n => !isWorkspaceFolder(n.uri.fsPath) && path.dirname(n.uri.fsPath) !== folder.fsPath);
    if (items.length === 0) return;
    if (vscode.workspace.getConfiguration('explorer').get('confirmDragAndDrop', true)) {
      const what = items.length === 1 ? `'${path.basename(items[0].uri.fsPath)}'` : `these ${items.length} items`;
      const choice = await vscode.window.showWarningMessage(
        `Are you sure you want to move ${what} into '${path.basename(folder.fsPath)}'?`,
        { modal: true, detail: 'Turn off explorer.confirmDragAndDrop to move without asking.' },
        'Move',
      );
      if (choice !== 'Move') return;
    }
    const moves = await this.planMoves(items, folder);
    if (moves && (await this.move(moves))) {
      await this.afterChange(items);
      const last = moves[moves.length - 1];
      await this.explorer.reveal(last.to, items.find(i => i.uri.fsPath === last.from.fsPath)!.isDir);
    }
  }

  /** Where each item goes when moved into `folder`, asking before replacing anything. */
  private async planMoves(
    items: readonly Item[],
    folder: vscode.Uri,
  ): Promise<Move[] | undefined> {
    const moves: Move[] = [];
    for (const item of items) {
      const name = path.basename(item.uri.fsPath);
      if (item.isDir && isAtOrInside(folder.fsPath, item.uri.fsPath)) {
        void vscode.window.showErrorMessage(`Can't move ${name} into itself.`);
        return undefined;
      }
      const to = vscode.Uri.file(path.join(folder.fsPath, name));
      if (to.fsPath === item.uri.fsPath) continue;
      let overwrite = false;
      if (await exists(to)) {
        const choice = await vscode.window.showWarningMessage(
          `'${name}' already exists in '${path.basename(folder.fsPath)}'. Do you want to replace it?`,
          { modal: true, detail: 'This will overwrite its current contents.' },
          'Replace',
        );
        if (choice !== 'Replace') return undefined;
        overwrite = true;
      }
      moves.push({ from: item.uri, to, overwrite });
    }
    return moves.length ? moves : undefined;
  }

  /**
   * Moves with a workspace edit, so open editors follow the file and language
   * extensions can update imports, as when moving in the built-in Explorer.
   */
  private async move(moves: readonly Move[]): Promise<boolean> {
    const edit = new vscode.WorkspaceEdit();
    for (const m of moves) edit.renameFile(m.from, m.to, { overwrite: m.overwrite });
    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) void vscode.window.showErrorMessage(`Couldn't move ${moves.map(m => path.basename(m.from.fsPath)).join(', ')}.`);
    return ok;
  }

  /** Looks for repos again when a folder was moved, copied or deleted, since one may have been a repo. */
  private async afterChange(items: readonly Item[]): Promise<void> {
    if (items.some(i => i.isDir)) await this.store.discover();
  }

  /** Drag and drop inside the file tree moves items; dragging out hands over their file URIs. */
  readonly dragAndDrop: vscode.TreeDragAndDropController<ExplorerNode> = {
    dragMimeTypes: ['text/uri-list'],
    dropMimeTypes: [TREE_MIME],
    handleDrag: (dragged, dataTransfer) => {
      const source = this.explorer.withNestedFiles(dragged);
      dataTransfer.set(TREE_MIME, new vscode.DataTransferItem(source));
      dataTransfer.set('text/uri-list', new vscode.DataTransferItem(source.map(n => n.uri.toString()).join('\r\n')));
    },
    handleDrop: async (target, dataTransfer) => {
      const nodes = dataTransfer.get(TREE_MIME)?.value as ExplorerNode[] | undefined;
      const folder = target ? folderOf(target) : localFolders()[0]?.uri;
      if (nodes?.length && folder) await this.drop(nodes, folder);
    },
  };
}

/** An error message for a name the user typed, or undefined when it's fine. */
async function validate(parent: vscode.Uri, value: string): Promise<string | undefined> {
  const problem = checkNewPath(parent.fsPath, value);
  if (problem || !value.trim()) return problem;
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(path.join(parent.fsPath, value.trim())));
    return `${value.trim()} already exists here.`;
  } catch {
    return undefined;
  }
}
