// Integration tests of FileUndo on its own: each kind of operation undone and
// redone, asking first, refusing when the disk changed, and what a delete keeps.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { FileUndo, MAX_UNDO_FILE_SIZE, snapshotForUndo } from '../undo';
import { stub, test, withScratch } from './harness';

/** A FileUndo of its own, with the dialogs it shows answered and recorded. */
function undoWith(answer: string | undefined) {
  const shown: string[] = [];
  const changed: string[] = [];
  const undo = new FileUndo(async items => void changed.push(...items.map(i => path.basename(i.uri.fsPath))));
  const answers = (async (text: string) => {
    shown.push(text);
    return answer;
  }) as never;
  const restore = [stub(vscode.window, 'showInformationMessage', answers), stub(vscode.window, 'showErrorMessage', answers)];
  return { undo, shown, changed, restore: () => restore.forEach(r => r()) };
}

export function registerUndoTests(): void {
  test('undo asks before undoing a create, and keeps it when declined; redo makes it again', () =>
    withScratch(async dir => {
      const file = path.join(dir, 'made.txt');
      const folder = path.join(dir, 'made');
      writeFileSync(file, 'x');
      mkdirSync(folder);
      let t = undoWith(undefined);
      try {
        await t.undo.undo();
        await t.undo.redo();
        assert.deepEqual(t.shown, [], 'nothing to undo or redo');
        t.undo.record({ kind: 'create', label: 'Create made.txt', created: [{ path: file, isDir: false }, { path: folder, isDir: true }] });
        await t.undo.undo();
        assert.deepEqual(t.shown, ["Would you like to undo 'Create made.txt'?"]);
        assert.ok(existsSync(file), 'declined');
      } finally {
        t.restore();
      }
      const undo = t.undo;
      t = undoWith('Yes');
      try {
        await undo.undo();
        assert.ok(!existsSync(file) && !existsSync(folder), 'undone once agreed');
        await undo.redo();
        assert.equal(readFileSync(file, 'utf8'), '', 'made again, empty');
        assert.ok(existsSync(folder));
      } finally {
        t.restore();
      }
    }));

  test('pastes and dropped files are undone and redone from where they came from', () =>
    withScratch(async dir => {
      const source = path.join(dir, 'a.txt');
      const pasted = path.join(dir, 'sub', 'a.txt');
      const dropped = path.join(dir, 'sub', 'dropped.txt');
      writeFileSync(pasted, 'a\n');
      writeFileSync(dropped, 'a\n');
      const t = undoWith('Yes');
      try {
        t.undo.record({ kind: 'paste', label: 'Paste a.txt', created: [{ path: pasted, isDir: false, source }] });
        await t.undo.undo();
        assert.ok(!existsSync(pasted));
        await t.undo.redo();
        assert.equal(readFileSync(pasted, 'utf8'), 'a\n', 'copied again');
        t.undo.record({ kind: 'import', label: 'Import a.txt', created: [{ path: dropped, isDir: false, source }] });
        await t.undo.undo();
        writeFileSync(dropped, 'in the way\n');
        await t.undo.redo();
        assert.equal(readFileSync(dropped, 'utf8'), 'a\n', 'an import replaces what is there, as it did');
        assert.deepEqual(t.changed, ['a.txt', 'a.txt', 'dropped.txt', 'dropped.txt'], 'the tree is told each time');
      } finally {
        t.restore();
      }
    }));

  test('deletes are undone with folders made again, and redone into the Trash or for good', () =>
    withScratch(async dir => {
      const folder = path.join(dir, 'gone');
      const file = path.join(dir, 'gone.txt');
      for (const permanently of [false, true]) {
        const t = undoWith('Yes');
        try {
          t.undo.record({ kind: 'delete', label: 'Delete', permanently, deleted: [{ path: folder, isDir: true }, { path: file, isDir: false, content: new TextEncoder().encode('kept') }] });
          await t.undo.undo();
          assert.ok(existsSync(folder) && readFileSync(file, 'utf8') === 'kept');
          await t.undo.redo();
          assert.ok(!existsSync(folder) && !existsSync(file));
        } finally {
          t.restore();
        }
      }
    }));

  test('an undo VS Code refuses is reported', () =>
    withScratch(async dir => {
      const from = path.join(dir, 'a.txt');
      const to = path.join(dir, 'b.txt');
      writeFileSync(to, 'a\n');
      const t = undoWith(undefined);
      const restore = stub(vscode.workspace, 'applyEdit', (async () => false) as never);
      try {
        t.undo.record({ kind: 'rename', label: 'Rename a.txt to b.txt', moves: [{ from, to }] });
        rmSync(from);
        await t.undo.undo();
        assert.deepEqual(t.shown, ["Couldn't undo 'Rename a.txt to b.txt': VS Code refused the move"]);
      } finally {
        restore();
        t.restore();
      }
    }));

  test('a delete keeps files up to 5 MB and folders, and skips what is gone already', () =>
    withScratch(async dir => {
      const big = path.join(dir, 'big.bin');
      writeFileSync(big, Buffer.alloc(MAX_UNDO_FILE_SIZE + 1));
      const kept = await snapshotForUndo([
        { uri: vscode.Uri.file(path.join(dir, 'a.txt')), isDir: false },
        { uri: vscode.Uri.file(path.join(dir, 'sub')), isDir: true },
        { uri: vscode.Uri.file(big), isDir: false },
        { uri: vscode.Uri.file(path.join(dir, 'missing.txt')), isDir: false },
      ]);
      assert.deepEqual(
        kept.map(k => [path.basename(k.path), k.isDir, k.content?.length]),
        [
          ['a.txt', false, 2],
          ['sub', true, undefined],
        ],
      );
    }));
}
