import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkEntry, parseExcludes, ROOT_STATE, type EntryToCheck, type VisibilityState } from '../core/visibility';

const entry = (relPath: string, extra: Partial<EntryToCheck> = {}): EntryToCheck => ({
  relPath,
  name: relPath.split('/').pop()!,
  isDir: false,
  parent: ROOT_STATE,
  ...extra,
});

test('files.exclude hides matching entries, with any glob', () => {
  const rules = parseExcludes({ '**/.git': true, '**/*.pyc': true, 'build/': true, '**/off': false });
  assert.equal(checkEntry(rules, entry('.git', { isDir: true })).visible, false);
  assert.equal(checkEntry(rules, entry('src/a.pyc')).visible, false);
  assert.equal(checkEntry(rules, entry('src/a.py')).visible, true);
  assert.equal(checkEntry(rules, entry('build', { isDir: true })).visible, false, 'a trailing slash is trimmed');
  assert.equal(checkEntry(rules, entry('off')).visible, true, 'a pattern set to false hides nothing');
});

test('when clauses check for a sibling', () => {
  const rules = parseExcludes({ '**/*.js': { when: '$(basename).ts' } });
  const siblings = new Set(['a.ts', 'a.js', 'b.js']);
  const hasSibling = (name: string) => siblings.has(name);
  assert.equal(checkEntry(rules, entry('a.js', { hasSibling })).visible, false);
  assert.equal(checkEntry(rules, entry('b.js', { hasSibling })).visible, true);
});

test('children of an excluded folder are excluded unless an exception matches', () => {
  const rules = parseExcludes({ 'dist': true, '!dist/keep.txt': true });
  const dist = checkEntry(rules, entry('dist', { isDir: true }));
  assert.equal(dist.visible, true, 'shown, because the exception lies inside it');
  assert.deepEqual(dist.state, { isExcluded: false, leadsToException: true });
  assert.equal(checkEntry(rules, entry('dist/keep.txt', { parent: dist.state })).visible, true);
  assert.equal(checkEntry(rules, entry('dist/other.txt', { parent: dist.state })).visible, false);
});

test('an excluded item stays shown while an editor shows it or something inside it', () => {
  const rules = parseExcludes({ 'out': true });
  const hidden = checkEntry(rules, entry('out', { isDir: true }));
  assert.equal(hidden.visible, false);
  const shown = checkEntry(rules, entry('out', { isDir: true, hasEditorInside: () => true }));
  assert.equal(shown.visible, true);
  assert.equal(shown.shownForEditor, true);
  const parent: VisibilityState = shown.state;
  assert.equal(checkEntry(rules, entry('out/a.js', { parent })).visible, false, 'siblings of the open file stay hidden');
  assert.equal(checkEntry(rules, entry('out/b.js', { parent, hasEditorInside: () => true })).visible, true);
});

test('isHidden (such as .gitignore) hides, and exceptions show it again', () => {
  const rules = parseExcludes({ '!logs/keep.log': true });
  assert.equal(checkEntry(rules, entry('a.log', { isHidden: () => true })).visible, false);
  assert.equal(checkEntry(rules, entry('logs/keep.log', { isHidden: () => true })).visible, true);
});
