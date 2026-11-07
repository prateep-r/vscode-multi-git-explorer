// Integration tests of the file commands' less common paths: names typed in
// the input box, refusals and failures, dialogs answered either way, and drops
// of every kind. withScratch's tests in suite.ts cover the usual paths.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ExplorerNode } from '../views/repoExplorer';
import { sample, stub, test, withScratch } from './harness';

type Shown = { kind: 'warning' | 'error' | 'info'; text: string; detail?: string; buttons: string[] };

/** Records dialogs, answering each in turn from `answers` (undefined cancels). */
function dialogs(answers: (string | undefined)[] = []) {
  const shown: Shown[] = [];
  const answer = (kind: Shown['kind']) =>
    (async (text: string, ...rest: unknown[]) => {
      const options = rest.find((r): r is vscode.MessageOptions => typeof r === 'object' && r !== null);
      shown.push({ kind, text, detail: options?.detail, buttons: rest.filter((r): r is string => typeof r === 'string') });
      return answers.shift();
    }) as never;
  const restore = [
    stub(vscode.window, 'showWarningMessage', answer('warning')),
    stub(vscode.window, 'showErrorMessage', answer('error')),
    stub(vscode.window, 'showInformationMessage', answer('info')),
  ];
  return { shown, restore: () => restore.forEach(r => r()) };
}

/** Answers input boxes in turn, keeping the options each was shown with. */
function inputs(answers: (string | undefined)[]) {
  const asked: vscode.InputBoxOptions[] = [];
  const restore = stub(vscode.window, 'showInputBox', (async (options: vscode.InputBoxOptions) => {
    asked.push(options);
    return answers.shift();
  }) as never);
  return { asked, restore };
}

/** A DataTransfer as VS Code hands over a drop from outside: a uri-list, and files. */
function outsideDrop(uriList: string | undefined, files: vscode.Uri[] = []): vscode.DataTransfer {
  const data = new vscode.DataTransfer();
  if (uriList !== undefined) data.set('text/uri-list', new vscode.DataTransferItem(uriList));
  files.forEach((uri, i) => {
    const item = new vscode.DataTransferItem('');
    item.asFile = () => ({ name: path.basename(uri.fsPath), uri, data: async () => new Uint8Array() });
    data.set(`files-${i}`, item);
  });
  return data;
}

const token = () => new vscode.CancellationTokenSource().token;

export function registerFileCommandTests(): void {
  test('New File and New Folder ask for a name, check it, and report what fails', ({ explorer }) =>
    withScratch(async (dir, node) => {
      const root: ExplorerNode = { uri: vscode.Uri.file(sample), isDir: true };
      let typed = inputs([undefined, 'new-dir', '   ']);
      try {
        await vscode.commands.executeCommand('multiGitExplorer.newFile', root);
        await vscode.commands.executeCommand('multiGitExplorer.newFolder', node('sub', true));
        await vscode.commands.executeCommand('multiGitExplorer.newFile', node('a.txt'));
      } finally {
        typed.restore();
      }
      assert.deepEqual(
        typed.asked.map(o => [o.title, o.prompt, o.placeHolder]),
        [
          ['New File', `In ${path.basename(sample)}/`, 'name.ts, or a path like src/utils/date.ts'],
          ['New Folder', `In ${path.basename(sample)}/docs/scratch/sub/`, 'name, or a path like src/utils'],
          ['New File', `In ${path.basename(sample)}/docs/scratch/`, 'name.ts, or a path like src/utils/date.ts'],
        ],
      );
      assert.ok(existsSync(path.join(dir, 'sub', 'new-dir')), 'a folder made from the input box');
      assert.equal(await typed.asked[0].validateInput!('a.txt'), undefined, 'checked against the workspace folder');
      assert.equal(await typed.asked[2].validateInput!('a.txt'), 'a.txt already exists here.');
      assert.equal(await typed.asked[2].validateInput!(''), undefined);

      const d = dialogs();
      const restoreApply = stub(vscode.workspace, 'applyEdit', (async () => false) as never);
      try {
        await vscode.commands.executeCommand('multiGitExplorer.newFile', node('sub', true), 'nested/');
        await vscode.commands.executeCommand('multiGitExplorer.newFile', node('sub', true), 'new-dir');
        await vscode.commands.executeCommand('multiGitExplorer.newFolder', node('sub', true), '../../../../outside');
        await vscode.commands.executeCommand('multiGitExplorer.newFolder', node('a.txt'), 'a.txt/inside');
        await vscode.commands.executeCommand('multiGitExplorer.newFile', node('sub', true), 'refused.txt');
      } finally {
        restoreApply();
        d.restore();
      }
      assert.deepEqual(d.shown.map(s => s.text.replace(/:.*/, ':')), [
        'Enter a file name after the last "/".',
        'new-dir already exists here.',
        d.shown[2].text,
        "Couldn't create a.txt/inside:",
        "Couldn't create refused.txt.",
      ]);

      // Without a row, into the selected folder; without a workspace folder, nowhere.
      const selected = explorer.selectedFolder()!.fsPath;
      await vscode.commands.executeCommand('multiGitExplorer.newFolder', undefined, 'from-selection');
      assert.ok(existsSync(path.join(selected, 'from-selection')));
      const noFolders = stub(vscode.workspace, 'workspaceFolders', undefined);
      const noSelection = stub(explorer, 'selectedFolder', () => undefined);
      typed = inputs([]);
      try {
        await vscode.commands.executeCommand('multiGitExplorer.newFile');
        await vscode.commands.executeCommand('multiGitExplorer.paste');
      } finally {
        typed.restore();
        noSelection();
        noFolders();
      }
      assert.equal(typed.asked.length, 0, 'nothing asked');
    }));

  test('Rename asks with the name selected up to its extension, and refuses what can\'t be renamed', ({ files, explorer }) =>
    withScratch(async (dir, node) => {
      const d = dialogs();
      let typed = inputs([undefined, 'sub', 'a.txt', 'b/c']);
      try {
        await files.rename(node('a.txt'));
        await files.rename(node('sub', true));
        await files.rename(node('a.txt'));
        await files.rename(node('a.txt'));
        await files.rename({ uri: vscode.Uri.file(sample), isDir: true });
      } finally {
        typed.restore();
      }
      assert.deepEqual(typed.asked[0].valueSelection, [0, 1], 'a.txt: the name without .txt');
      assert.deepEqual(typed.asked[1].valueSelection, [0, 3], 'a folder: all of it');
      assert.equal(await typed.asked[0].validateInput!('sub'), 'sub already exists here.');
      assert.equal(await typed.asked[0].validateInput!('A.TXT'), undefined, 'only the case changes');
      assert.equal(await typed.asked[0].validateInput!('a.txt'), undefined);
      assert.ok(existsSync(path.join(dir, 'a.txt')), 'cancelled, or the same name');
      assert.equal(d.shown.length, 2, 'b/c is refused');
      assert.equal(d.shown[1].text, 'A workspace folder can’t be renamed here.');

      // Without a row, the selected one; from the keyboard on a row that can't be renamed, Enter opens it instead.
      // Other tests may have shown another view; the tree has to be showing to select a row.
      await vscode.commands.executeCommand('workbench.view.extension.multiGitExplorer');
      await explorer.reveal(vscode.Uri.file(path.join(dir, 'a.txt')), false);
      typed = inputs(['renamed.txt']);
      const selected: string[] = [];
      const listSelect = stub(explorer, 'focusedRow', async () => ({ uri: vscode.Uri.file(sample), isDir: true }));
      const execute = vscode.commands.executeCommand;
      const intercept = stub(vscode.commands, 'executeCommand', ((id: string, ...args: unknown[]) => {
        if (id !== 'list.select') return execute(id, ...args);
        selected.push(id);
        return Promise.resolve();
      }) as never);
      try {
        await vscode.commands.executeCommand('multiGitExplorer.rename');
        await vscode.commands.executeCommand('multiGitExplorer.rename', { keyboard: true });
      } finally {
        intercept();
        listSelect();
        typed.restore();
      }
      assert.ok(existsSync(path.join(dir, 'renamed.txt')), 'the selected row');
      assert.deepEqual(selected, ['list.select']);

      const refuse = stub(vscode.workspace, 'applyEdit', (async () => false) as never);
      try {
        await files.rename(node('renamed.txt'), 'never.txt');
      } finally {
        refuse();
        d.restore();
      }
      assert.deepEqual(d.shown.at(-1)?.text, "Couldn't move renamed.txt.");
    }));

  test('Delete says what it will do, warns of unsaved files, and reports what it couldn\'t delete', ({ files }) =>
    withScratch(async (dir, node) => {
      for (const name of ['b.txt', 'c.txt', 'd.txt']) writeFileSync(path.join(dir, 'sub', name), name);
      const docs = await Promise.all(['b.txt', 'c.txt'].map(n => vscode.workspace.openTextDocument(path.join(dir, 'sub', n))));
      const edit = new vscode.WorkspaceEdit();
      for (const doc of docs) edit.insert(doc.uri, new vscode.Position(0, 0), 'unsaved ');
      await vscode.workspace.applyEdit(edit);
      await vscode.workspace.getConfiguration('explorer').update('confirmDelete', true, vscode.ConfigurationTarget.Global);
      // Every dialog is cancelled, so nothing goes to the real Trash.
      await vscode.workspace.getConfiguration('files').update('enableTrash', true, vscode.ConfigurationTarget.Global);
      let d = dialogs([undefined, undefined, undefined]);
      try {
        await files.delete([node('sub/b.txt')]);
        await files.delete([node('sub', true), node('sub/c.txt'), node('a.txt')]);
        await files.delete([node('a.txt')], { permanently: true });
        await files.delete([{ uri: vscode.Uri.file(sample), isDir: true }]);
      } finally {
        d.restore();
        await vscode.workspace.getConfiguration('files').update('enableTrash', false, vscode.ConfigurationTarget.Global);
      }
      assert.deepEqual(
        d.shown.map(s => [s.text, s.detail, s.buttons]),
        [
          ["Are you sure you want to delete 'b.txt'?", 'A file with unsaved changes will stay open, marked as deleted.\n\nYou can restore it from the Trash.', ['Move to Trash']],
          ['Are you sure you want to delete these 2 items?', 'sub\na.txt\n\n2 files with unsaved changes will stay open, marked as deleted.\n\nYou can restore them from the Trash.', ['Move to Trash']],
          ["Are you sure you want to permanently delete 'a.txt'?", 'This can’t be undone.', ['Delete']],
        ],
        'a folder takes the files inside it; a workspace folder is never deleted',
      );
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      await vscode.commands.executeCommand('workbench.action.files.revert');
      for (const doc of docs) {
        await vscode.window.showTextDocument(doc);
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      }

      // A file that can't be deleted, next to one that can.
      chmodSync(path.join(dir, 'sub'), 0o555);
      d = dialogs(['Delete']);
      try {
        await files.delete([node('sub/d.txt'), node('a.txt')]);
      } finally {
        chmodSync(path.join(dir, 'sub'), 0o755);
        d.restore();
      }
      assert.match(d.shown.at(-1)!.text, /^Couldn't delete d\.txt: /);
      assert.ok(existsSync(path.join(dir, 'sub', 'd.txt')) && !existsSync(path.join(dir, 'a.txt')));
    }));

  test('Paste and drag and drop: cancelled, refused, into themselves, failing, and onto the same folder', ({ files, explorer }) =>
    withScratch(async (dir, node) => {
      mkdirSync(path.join(dir, 'other'));
      writeFileSync(path.join(dir, 'other', 'a.txt'), 'other\n');
      writeFileSync(path.join(dir, 'b.txt'), 'b\n');
      const config = vscode.workspace.getConfiguration('explorer');
      await config.update('confirmDragAndDrop', true, vscode.ConfigurationTarget.Global);
      let d = dialogs([undefined, undefined]);
      try {
        await files.drop([node('a.txt'), node('b.txt')], vscode.Uri.file(path.join(dir, 'sub')));
        await files.drop([node('a.txt')], vscode.Uri.file(path.join(dir, 'other')));
        await files.drop([node('a.txt')], vscode.Uri.file(dir));
      } finally {
        d.restore();
      }
      assert.deepEqual(d.shown.map(s => s.text), ["Are you sure you want to move these 2 items into 'sub'?", "Are you sure you want to move 'a.txt' into 'other'?"]);
      await config.update('confirmDragAndDrop', false, vscode.ConfigurationTarget.Global);

      // Replace in other: no. Pasting a.txt onto itself with incrementalNaming off: Replace, which leaves it as it is.
      d = dialogs([undefined, undefined, undefined, 'Replace', undefined]);
      try {
        await files.drop([node('a.txt')], vscode.Uri.file(path.join(dir, 'other')));
        await files.drop([node('sub', true)], vscode.Uri.file(path.join(dir, 'sub')));
        await files.setClipboard([node('a.txt')], true);
        await files.paste(vscode.Uri.file(dir));
        await files.setClipboard([node('sub', true)], false);
        await files.paste(vscode.Uri.file(path.join(dir, 'sub')));
        await config.update('incrementalNaming', 'disabled', vscode.ConfigurationTarget.Global);
        await files.setClipboard([node('a.txt')], false);
        await files.paste(vscode.Uri.file(dir));
        d.shown.push({ kind: 'info', text: '--', buttons: [] });
        await files.paste(vscode.Uri.file(path.join(dir, 'other')));
      } finally {
        await config.update('incrementalNaming', undefined, vscode.ConfigurationTarget.Global);
        d.restore();
      }
      assert.deepEqual(d.shown.map(s => s.text), [
        "'a.txt' already exists in 'other'. Do you want to replace it?",
        "Can't move sub into itself.",
        "Can't paste sub into itself.",
        "A file or folder with the name 'a.txt' already exists in the destination folder. Do you want to replace it?",
        '--',
        "A file or folder with the name 'a.txt' already exists in the destination folder. Do you want to replace it?",
      ]);
      assert.equal(readFileSync(path.join(dir, 'other', 'a.txt'), 'utf8'), 'other\n', 'nothing replaced, and a cut pasted in place stays');
      assert.ok(existsSync(path.join(dir, 'a.txt')));

      // A paste that fails, and a move VS Code refuses.
      chmodSync(path.join(dir, 'sub'), 0o555);
      d = dialogs();
      try {
        await files.setClipboard([node('a.txt')], false);
        await files.paste(vscode.Uri.file(path.join(dir, 'sub')));
      } finally {
        chmodSync(path.join(dir, 'sub'), 0o755);
      }
      const refuse = stub(vscode.workspace, 'applyEdit', (async () => false) as never);
      try {
        await files.drop([node('b.txt')], vscode.Uri.file(path.join(dir, 'sub')));
      } finally {
        refuse();
        d.restore();
      }
      assert.match(d.shown[0].text, /^Couldn't paste a\.txt: /);
      assert.equal(d.shown[1].text, "Couldn't move b.txt.");

      // Escape cancels a cut only on a cut row; elsewhere it clears the selection.
      const cleared: string[] = [];
      const execute = vscode.commands.executeCommand;
      const intercept = stub(vscode.commands, 'executeCommand', ((id: string, ...args: unknown[]) => {
        if (id !== 'list.clear') return execute(id, ...args);
        cleared.push(id);
        return Promise.resolve();
      }) as never);
      let focused: ExplorerNode | undefined = node('b.txt');
      const focus = stub(explorer, 'focusedRow', async () => focused);
      try {
        await files.setClipboard([node('a.txt')], true);
        await vscode.commands.executeCommand('multiGitExplorer.cancelCut');
        assert.ok(files.isCut(path.join(dir, 'a.txt')), 'b.txt is not cut');
        focused = node('a.txt');
        await vscode.commands.executeCommand('multiGitExplorer.cancelCut');
        assert.ok(!files.isCut(path.join(dir, 'a.txt')));
        files.cancelCut();
        focused = undefined;
        await vscode.commands.executeCommand('multiGitExplorer.cancelCut');
        await vscode.commands.executeCommand('multiGitExplorer.paste', { keyboard: true });
      } finally {
        focus();
        intercept();
      }
      assert.deepEqual(cleared, ['list.clear', 'list.clear']);
    }));

  test('drops from outside: folders onto a workspace folder, missing and unreadable files, odd URIs', ({ files }) =>
    withScratch(async (dir, node) => {
      const outside = mkdtempSync(path.join(tmpdir(), 'multi-git-explorer-drop-'));
      const rootFolder: ExplorerNode = { uri: vscode.Uri.file(sample), isDir: true };
      const drop = (target: ExplorerNode | undefined, data: vscode.DataTransfer) => files.dragAndDrop.handleDrop!(target, data, token());
      const uri = (name: string) => vscode.Uri.file(path.join(outside, name));
      for (const name of ['one', 'two']) mkdirSync(path.join(outside, name));
      writeFileSync(path.join(outside, 'note.txt'), 'note\n');
      const update = stub(vscode.workspace, 'updateWorkspaceFolders', ((...args: unknown[]) => void added.push(args)) as never);
      const added: unknown[][] = [];
      let d = dialogs([undefined, 'Add Folder to Workspace', 'Add Folders to Workspace', 'Copy Folder']);
      try {
        await drop(rootFolder, outsideDrop(uri('one').toString()));
        await drop(rootFolder, outsideDrop(uri('one').toString()));
        await drop(rootFolder, outsideDrop(`${uri('one')}\r\n${uri('two')}`));
        await drop(rootFolder, outsideDrop(uri('two').toString()));
      } finally {
        d.restore();
        update();
      }
      assert.deepEqual(d.shown.map(s => [s.text, s.buttons]), [
        ["Do you want to copy 'one' or add 'one' as a folder to the workspace?", ['Add Folder to Workspace', 'Copy Folder']],
        ["Do you want to copy 'one' or add 'one' as a folder to the workspace?", ['Add Folder to Workspace', 'Copy Folder']],
        ['Do you want to copy the folders or add the folders to the workspace?', ['Add Folders to Workspace', 'Copy Folders']],
        ["Do you want to copy 'two' or add 'two' as a folder to the workspace?", ['Add Folder to Workspace', 'Copy Folder']],
      ]);
      assert.equal(added.length, 2, 'added to the workspace instead of copied');
      assert.ok(existsSync(path.join(sample, 'two')), 'copied when asked to');
      rmSync(path.join(sample, 'two'), { recursive: true });

      d = dialogs([undefined]);
      try {
        // Files dropped as files (from Finder), skipping what isn't on disk; a file already there; a file in its own folder.
        await drop(node('sub', true), outsideDrop(undefined, [uri('note.txt'), vscode.Uri.parse('untitled:Untitled-1')]));
        await drop(node('sub', true), outsideDrop(uri('note.txt').toString()));
        await drop(node('sub', true), outsideDrop(vscode.Uri.file(path.join(dir, 'sub', 'note.txt')).toString()));
        await drop(node('sub', true), outsideDrop(`not a uri\r\nhttps://example.com/x\r\n${uri('missing-1')}\r\n${uri('missing-2')}`));
        await drop(node('sub', true), outsideDrop(uri('missing-1').toString()));
        // Below the rows: the last workspace folder; and none without one.
        const noFolders = stub(vscode.workspace, 'workspaceFolders', undefined);
        try {
          await drop(undefined, outsideDrop(uri('note.txt').toString()));
        } finally {
          noFolders();
        }
      } finally {
        d.restore();
      }
      assert.equal(readFileSync(path.join(dir, 'sub', 'note.txt'), 'utf8'), 'note\n');
      assert.deepEqual(d.shown.map(s => s.text), [
        "A file or folder with the name 'note.txt' already exists in the destination folder. Do you want to replace it?",
        'Some or all of the dropped files could not be accessed for import.',
        'The dropped file could not be accessed for import.',
      ]);

      // A folder that can't be written to.
      chmodSync(path.join(dir, 'sub'), 0o555);
      d = dialogs();
      try {
        await drop(node('sub', true), outsideDrop(uri('one').toString()));
      } finally {
        chmodSync(path.join(dir, 'sub'), 0o755);
        d.restore();
        rmSync(outside, { recursive: true, force: true });
      }
      assert.match(d.shown[0].text, /^Couldn't copy one: /);
    }));
}
