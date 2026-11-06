import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareEntries, readSortConfig, type Sortable, type SortConfig } from '../core/sort';

const entries: Sortable[] = [
  { name: 'b.ts', isDir: false, mtime: 3 },
  { name: 'src', isDir: true, mtime: 1 },
  { name: 'A.md', isDir: false, mtime: 1 },
  { name: 'file10.txt', isDir: false, mtime: 2 },
  { name: 'file9.txt', isDir: false, mtime: 2 },
  { name: 'Docs', isDir: true, mtime: 5 },
];
const sorted = (config: Partial<SortConfig>, list = entries) =>
  [...list].sort(compareEntries({ order: 'default', lexicographic: 'default', reverse: false, ...config })).map(e => e.name);

test('default: folders first, then names in natural order', () => {
  assert.deepEqual(sorted({}), ['Docs', 'src', 'A.md', 'b.ts', 'file9.txt', 'file10.txt']);
});

test('mixed, filesFirst and type', () => {
  assert.deepEqual(sorted({ order: 'mixed' }), ['A.md', 'b.ts', 'Docs', 'file9.txt', 'file10.txt', 'src']);
  assert.deepEqual(sorted({ order: 'filesFirst' }), ['A.md', 'b.ts', 'file9.txt', 'file10.txt', 'Docs', 'src']);
  assert.deepEqual(sorted({ order: 'type' }), ['Docs', 'src', 'A.md', 'b.ts', 'file9.txt', 'file10.txt']);
});

test('modified: newest first among files, folders still first', () => {
  assert.deepEqual(sorted({ order: 'modified' }), ['Docs', 'src', 'b.ts', 'file9.txt', 'file10.txt', 'A.md']);
});

test('foldersNestsFiles puts files with nested files before the rest', () => {
  const list: Sortable[] = [
    { name: 'a.txt', isDir: false },
    { name: 'package.json', isDir: false, hasNests: true },
    { name: 'lib', isDir: true },
  ];
  assert.deepEqual(sorted({ order: 'foldersNestsFiles' }, list), ['lib', 'package.json', 'a.txt']);
});

test('reverse also puts folders last, like the built-in Explorer', () => {
  assert.deepEqual(sorted({ reverse: true }), ['file10.txt', 'file9.txt', 'b.ts', 'A.md', 'src', 'Docs']);
});

test('lexicographic options: upper or lower case names grouped first, and unicode order', () => {
  const list: Sortable[] = ['b', 'B', 'a', 'A'].map(name => ({ name, isDir: false }));
  assert.deepEqual(sorted({ lexicographic: 'upper' }, list), ['A', 'B', 'a', 'b']);
  assert.deepEqual(sorted({ lexicographic: 'lower' }, list), ['a', 'b', 'A', 'B']);
  assert.deepEqual(sorted({ lexicographic: 'unicode' }, list), ['A', 'B', 'a', 'b']);
});

test('readSortConfig falls back to the defaults for unknown values', () => {
  assert.deepEqual(readSortConfig('nonsense', 7, 'yes'), { order: 'default', lexicographic: 'default', reverse: false });
  assert.deepEqual(readSortConfig('type', 'upper', true), { order: 'type', lexicographic: 'upper', reverse: true });
});
