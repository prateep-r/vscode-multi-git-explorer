import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compactChain } from '../core/compact';

/** A fake disk: each folder's entries, with a trailing slash for folders. */
function disk(tree: Record<string, string[]>) {
  return async (dir: string) => {
    const entries = tree[dir] ?? [];
    return entries.length === 1 && entries[0].endsWith('/') ? `${dir}/${entries[0].slice(0, -1)}` : undefined;
  };
}

test('folders holding only one folder are shown as one row', async () => {
  const fs = disk({ src: ['main/'], 'src/main': ['java/'], 'src/main/java': ['App.java', 'util/'] });
  assert.deepEqual(await compactChain('src', fs), ['src', 'src/main', 'src/main/java']);
});

test('a folder with a file, or with more than one entry, ends the chain', async () => {
  assert.deepEqual(await compactChain('a', disk({ a: ['b/'], 'a/b': ['only.txt'] })), ['a', 'a/b']);
  assert.deepEqual(await compactChain('a', disk({ a: ['b/', 'c/'] })), ['a']);
  assert.deepEqual(await compactChain('a', disk({ a: [] })), ['a']);
});

test('hidden entries count, so a repo folder (with .git) takes in nothing', async () => {
  const fs = disk({ org: ['repo/'], 'org/repo': ['.git/', 'src/'] });
  assert.deepEqual(await compactChain('org', fs), ['org', 'org/repo'], 'a repo can end a chain');
  assert.deepEqual(await compactChain('org/repo', fs), ['org/repo']);
  assert.deepEqual(await compactChain('x', disk({ x: ['.DS_Store', 'y/'] })), ['x']);
});

test('a chain stops at the length limit', async () => {
  const deep = async (dir: string) => `${dir}/d`;
  assert.equal((await compactChain('a', deep, 5)).length, 5);
});
