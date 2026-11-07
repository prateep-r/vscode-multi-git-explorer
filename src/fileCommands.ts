import * as path from 'path';
import * as vscode from 'vscode';
import { checkNewName, checkNewPath } from './core/fileNames';
import { incrementFileName } from './core/vs/incrementFileName';
import { isAtOrInside } from './core/paths';
import { undoLabel } from './core/undo';
import { parseUriList } from './core/uriList';
import type { RepoStore } from './store';
import type { ExplorerNode, RepoExplorerProvider } from './views/repoExplorer';
import { FileUndo, names, snapshotForUndo } from './undo';
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
    // A workspace folder itself comes back as its full path, so it's named by its folder name.
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
        void vscode.window.showErrorMessage(`Couldn't create ${entered.trim()}: ${messageOf(error)}`);
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
    files.undo.record({ kind: 'create', label: undoLabel('create', [entered.trim()]), created: [{ path: uri.fsPath, isDir: kind === 'folder' }] });
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
    vscode.commands.registerCommand('multiGitExplorer.undo', () => files.undo.undo()),
    vscode.commands.registerCommand('multiGitExplorer.redo', () => files.undo.redo()),
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

  /** Undo and redo of what's done here, with Cmd/Ctrl+Z in the tree. */
  readonly undo: FileUndo;

  constructor(
    private readonly store: RepoStore,
    private readonly explorer: RepoExplorerProvider,
  ) {
    this.undo = new FileUndo(changed => this.afterChange(changed));
  }

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
      this.undo.record({ kind: 'rename', label: undoLabel('rename', [oldName], newName), moves: [{ from: node.uri.fsPath, to: target.fsPath }] });
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
      /* c8 ignore next -- the other systems' name; the tests run on one system at a time */
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
    const kept = await snapshotForUndo(targets);
    const failed: string[] = [];
    const deleted = new Set<string>();
    for (const target of targets) {
      try {
        await vscode.workspace.fs.delete(target.uri, { recursive: true, useTrash });
        deleted.add(target.uri.fsPath);
      } catch (error) {
        failed.push(`${path.basename(target.uri.fsPath)}: ${messageOf(error)}`);
      }
    }
    const restorable = kept.filter(k => deleted.has(k.path));
    if (restorable.length) {
      this.undo.record({ kind: 'delete', label: undoLabel('delete', names([...deleted])), deleted: restorable, permanently: !useTrash });
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
    const copiedFrom = new Map<string, string>();
    if (clipboard.cut) {
      const moves = await this.planMoves(clipboard.items, folder);
      if (moves && (await this.move(moves))) {
        this.recordMoves(moves);
        pasted.push(...moves.map(m => ({ uri: m.to, isDir: clipboard.items.find(i => i.uri.fsPath === m.from.fsPath)!.isDir })));
        // A cut can only be pasted once, like the built-in Explorer.
        this.replaceClipboard(undefined);
        void vscode.commands.executeCommand('setContext', 'multiGitExplorer.canPaste', false);
      }
    } else {
      const naming = incrementalNaming();
      for (const item of clipboard.items) {
        if (item.isDir && isAtOrInside(folder.fsPath, item.uri.fsPath)) {
          void vscode.window.showErrorMessage(`Can't paste ${path.basename(item.uri.fsPath)} into itself.`);
          continue;
        }
        const name = path.basename(item.uri.fsPath);
        const target = await pasteTarget(folder, name, item.isDir, naming);
        if (!target) continue;
        // With `explorer.incrementalNaming` off, pasting a file onto itself leaves it as it is.
        if (target.fsPath === item.uri.fsPath) continue;
        try {
          await vscode.workspace.fs.copy(item.uri, target, { overwrite: naming === 'disabled' });
          pasted.push({ uri: target, isDir: item.isDir });
          copiedFrom.set(target.fsPath, item.uri.fsPath);
        } catch (error) {
          void vscode.window.showErrorMessage(`Couldn't paste ${name}: ${messageOf(error)}`);
        }
      }
    }
    if (pasted.length === 0) return;
    if (!clipboard.cut) {
      this.undo.record({
        kind: 'paste',
        label: undoLabel('paste', names(pasted.map(p => p.uri.fsPath))),
        created: pasted.map(p => ({ path: p.uri.fsPath, isDir: p.isDir, source: copiedFrom.get(p.uri.fsPath) })),
      });
    }
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
      this.recordMoves(moves);
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
  private recordMoves(moves: readonly Move[]): void {
    this.undo.record({
      kind: 'move',
      label: undoLabel('move', names(moves.map(m => m.to.fsPath))),
      moves: moves.map(m => ({ from: m.from.fsPath, to: m.to.fsPath })),
    });
  }

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

  /**
   * Copies files dropped from outside the tree, such as from Finder, into
   * `folder`, as the built-in Explorer's ExternalFileImport does: folders
   * dropped on a workspace folder can be added to the workspace instead,
   * existing names are replaced only after asking, and a single dropped file
   * opens when `explorer.autoOpenDroppedFile` is on.
   */
  async importDropped(sources: readonly vscode.Uri[], folder: vscode.Uri): Promise<void> {
    let inaccessible = 0;
    const found: Item[] = [];
    for (const uri of sources) {
      try {
        found.push({ uri, isDir: ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory) !== 0 });
      } catch {
        inaccessible++;
      }
    }
    const folders = found.filter(f => f.isDir);
    if (folders.length && isWorkspaceFolder(folder.fsPath)) {
      const add = folders.length > 1 ? 'Add Folders to Workspace' : 'Add Folder to Workspace';
      const copy = folders.length > 1 ? 'Copy Folders' : 'Copy Folder';
      const name = path.basename(folders[0].uri.fsPath);
      const choice = await vscode.window.showInformationMessage(
        folders.length > 1
          ? 'Do you want to copy the folders or add the folders to the workspace?'
          : `Do you want to copy '${name}' or add '${name}' as a folder to the workspace?`,
        { modal: true },
        add,
        copy,
      );
      if (choice === add) {
        // Dropped on a workspace folder, so there are some.
        const count = vscode.workspace.workspaceFolders!.length;
        vscode.workspace.updateWorkspaceFolders(count, 0, ...folders.map(f => ({ uri: f.uri })));
        return;
      }
      if (choice !== copy) return;
    }

    // Names that differ only in case are the same file, except on Linux.
    /* c8 ignore next -- the other systems' rule; the tests run on one system at a time */
    const key = process.platform === 'linux' ? (name: string) => name : (name: string) => name.toLowerCase();
    let taken = new Set<string>();
    try {
      taken = new Set((await vscode.workspace.fs.readDirectory(folder)).map(([name]) => key(name)));
    } catch {
      // A folder that can't be read has nothing to replace.
    }
    const copies: { from: Item; to: vscode.Uri }[] = [];
    for (const item of found) {
      const name = path.basename(item.uri.fsPath);
      const to = vscode.Uri.file(path.join(folder.fsPath, name));
      if (to.fsPath === item.uri.fsPath) continue;
      if (taken.has(key(name))) {
        const choice = await vscode.window.showWarningMessage(
          `A file or folder with the name '${name}' already exists in the destination folder. Do you want to replace it?`,
          { modal: true, detail: 'This action is irreversible!' },
          'Replace',
        );
        if (choice !== 'Replace') continue;
      }
      copies.push({ from: item, to });
    }
    if (inaccessible) {
      void vscode.window.showErrorMessage(
        inaccessible > 1 ? 'Some or all of the dropped files could not be accessed for import.' : 'The dropped file could not be accessed for import.',
      );
    }
    const failed: string[] = [];
    const copied: (Item & { source: string })[] = [];
    for (const { from, to } of copies) {
      try {
        await vscode.workspace.fs.copy(from.uri, to, { overwrite: true });
        copied.push({ uri: to, isDir: from.isDir, source: from.uri.fsPath });
      } catch (error) {
        failed.push(`${path.basename(to.fsPath)}: ${messageOf(error)}`);
      }
    }
    if (failed.length) void vscode.window.showErrorMessage(`Couldn't copy ${failed.join('; ')}`);
    if (copied.length === 0) return;
    this.undo.record({
      kind: 'import',
      label: undoLabel('import', names(copied.map(c => c.uri.fsPath))),
      created: copied.map(c => ({ path: c.uri.fsPath, isDir: c.isDir, source: c.source })),
    });
    await this.afterChange(copied);
    const last = copied[copied.length - 1];
    await this.explorer.reveal(last.uri, last.isDir);
    if (copied.length === 1 && !last.isDir && vscode.workspace.getConfiguration('explorer').get('autoOpenDroppedFile') !== false) {
      await vscode.commands.executeCommand('vscode.open', last.uri, { preview: false });
    }
  }

  /**
   * Drag and drop inside the file tree moves items; files dropped from
   * elsewhere, such as Finder, are copied in; dragging out hands over their
   * file URIs. With `explorer.enableDragAndDrop` off nothing can be dropped,
   * but items can still be dragged out, as in the built-in Explorer.
   */
  readonly dragAndDrop: vscode.TreeDragAndDropController<ExplorerNode> = {
    dragMimeTypes: ['text/uri-list'],
    dropMimeTypes: [TREE_MIME, 'text/uri-list', 'files'],
    handleDrag: (dragged, dataTransfer) => {
      const source = this.explorer.withNestedFiles(dragged);
      dataTransfer.set(TREE_MIME, new vscode.DataTransferItem(source));
      dataTransfer.set('text/uri-list', new vscode.DataTransferItem(source.map(n => n.uri.toString()).join('\r\n')));
    },
    handleDrop: async (target, dataTransfer) => {
      if (vscode.workspace.getConfiguration('explorer').get<boolean>('enableDragAndDrop') === false) return;
      // Dropped below the rows, it goes into the last workspace folder, as in the built-in Explorer.
      const folder = target ? folderOf(target) : localFolders().at(-1)?.uri;
      if (!folder) return;
      const nodes = dataTransfer.get(TREE_MIME)?.value as ExplorerNode[] | undefined;
      if (nodes?.length) return this.drop(nodes, folder);
      const dropped = new Map<string, vscode.Uri>();
      const list = dataTransfer.get('text/uri-list');
      for (const text of list ? parseUriList(await list.asString()) : []) {
        try {
          const uri = vscode.Uri.parse(text, true);
          if (uri.scheme === 'file') dropped.set(uri.fsPath, uri);
        } catch {
          // Not a URI.
        }
      }
      for (const [, item] of dataTransfer) {
        const uri = item.asFile()?.uri;
        if (uri?.scheme === 'file') dropped.set(uri.fsPath, uri);
      }
      if (dropped.size) await this.importDropped([...dropped.values()], folder);
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

type IncrementalNaming = 'simple' | 'smart' | 'disabled';

function incrementalNaming(): IncrementalNaming {
  const value = vscode.workspace.getConfiguration('explorer').get<string>('incrementalNaming');
  return value === 'smart' || value === 'disabled' ? value : 'simple';
}

/**
 * Where a copy of `name` goes in `folder`, as the built-in Explorer picks it
 * (findValidPasteFileTarget): a free name per `explorer.incrementalNaming`,
 * or with it `disabled`, the same name once you agree to replace what's there.
 */
async function pasteTarget(folder: vscode.Uri, name: string, isDir: boolean, naming: IncrementalNaming): Promise<vscode.Uri | undefined> {
  let candidate = vscode.Uri.file(path.join(folder.fsPath, name));
  if (naming === 'disabled') {
    if (!(await exists(candidate))) return candidate;
    const choice = await vscode.window.showWarningMessage(
      `A file or folder with the name '${name}' already exists in the destination folder. Do you want to replace it?`,
      { modal: true },
      'Replace',
    );
    return choice === 'Replace' ? candidate : undefined;
  }
  while (await exists(candidate)) {
    name = incrementFileName(name, isDir, naming);
    candidate = vscode.Uri.file(path.join(folder.fsPath, name));
  }
  return candidate;
}

/** VS Code's file system API fails only with Errors (FileSystemError). */
function messageOf(error: unknown): string {
  return (error as Error).message;
}
