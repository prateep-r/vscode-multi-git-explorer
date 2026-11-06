import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseUriList } from '../core/uriList';

test('parseUriList reads one URI per line, skipping comments and blank lines', () => {
  assert.deepEqual(parseUriList('# from Finder\r\nfile:///a/b.txt\r\n\r\nfile:///c%20d\n'), ['file:///a/b.txt', 'file:///c%20d']);
  assert.deepEqual(parseUriList(''), []);
});
