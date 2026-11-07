import assert from 'node:assert/strict';
import { test } from 'node:test';
import { confirmsUndo, undoLabel, UndoStack } from '../core/undo';

test('undoing asks first like the built-in Explorer, per explorer.confirmUndo', () => {
  assert.equal(confirmsUndo('create', 'light'), true, 'creating always asks');
  assert.equal(confirmsUndo('delete', 'verbose'), false, 'deleting never asks');
  assert.equal(confirmsUndo('rename', 'default'), false);
  assert.equal(confirmsUndo('rename', 'verbose'), true);
  assert.equal(confirmsUndo('move', 'verbose'), true);
  assert.equal(confirmsUndo('paste', 'default'), true);
  assert.equal(confirmsUndo('import', 'light'), false);
});

test('undo labels are worded like the built-in Explorer', () => {
  assert.equal(undoLabel('delete', ['a.txt']), 'Delete a.txt');
  assert.equal(undoLabel('delete', ['a', 'b']), 'Delete 2 files');
  assert.equal(undoLabel('rename', ['a.txt'], 'b.txt'), 'Rename a.txt to b.txt');
  assert.equal(undoLabel('move', ['a', 'b', 'c']), 'Move 3 files');
  assert.equal(undoLabel('paste', ['a copy.txt']), 'Paste a copy.txt');
  assert.equal(undoLabel('import', ['x', 'y']), 'Import 2 resources');
  assert.equal(undoLabel('create', ['src/new.ts']), 'Create src/new.ts');
});

test('the undo stack moves operations between done and undone', () => {
  const stack = new UndoStack<string>();
  stack.record('a');
  stack.record('b');
  assert.equal(stack.takeUndo(), 'b');
  stack.undoneOp('b');
  assert.ok(stack.canRedo);
  assert.equal(stack.takeRedo(), 'b');
  stack.redoneOp('b');
  stack.takeUndo();
  stack.undoneOp('b');
  stack.record('c');
  assert.equal(stack.canRedo, false, 'a new operation clears what was undone');
  assert.equal(stack.takeUndo(), 'c');
  stack.cancelUndo('c');
  assert.equal(stack.takeUndo(), 'c', 'an undo the user declined stays on the stack');
});

test('labels for pasting several files', () => {
  assert.equal(undoLabel('paste', ['a', 'b']), 'Paste 2 files');
});
