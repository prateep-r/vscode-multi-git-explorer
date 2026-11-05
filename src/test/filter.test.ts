import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as path from 'path';
import { describeChange, filteredEntries, matchesFilter, type ExplorerFilter } from '../core/filter';
import type { ChangedFile, StatusSummary } from '../core/porcelain';

const ws = path.join(path.sep, 'ws');
const p = (...parts: string[]) => path.join(ws, ...parts);
const file = (filePath: string, letter: ChangedFile['letter'] = 'M', staged = false): ChangedFile => ({
  path: filePath,
  letter,
  staged,
  unstaged: !staged,
});

function status(changedFiles: number, branch: Partial<StatusSummary['branch']> = {}): StatusSummary {
  return {
    stash: 0,
    modified: 0,
    staged: 0,
    untracked: 0,
    conflicted: 0,
    changedFiles,
    files: [],
    branch: { detached: false, head: 'main', oid: 'abc', upstream: 'origin/main', ahead: 0, behind: 0, ...branch },
  };
}

test('matchesFilter combines the chosen filters with "or"', () => {
  const only = (...filters: ExplorerFilter[]) => new Set(filters);
  assert.equal(matchesFilter(status(2), only('changes')), true);
  assert.equal(matchesFilter(status(0), only('changes')), false);
  assert.equal(matchesFilter(status(0, { ahead: 1 }), only('changes')), false);
  assert.equal(matchesFilter(status(0, { ahead: 1 }), only('changes', 'unpushed')), true);
  assert.equal(matchesFilter(status(0, { upstream: undefined }), only('unpushed')), true, 'never-pushed branch');
  assert.equal(matchesFilter(status(0, { upstream: undefined }), only('unpushed'), false), false, 'local-only repo');
  assert.equal(matchesFilter(status(0, { behind: 3 }), only('behind')), true);
  assert.equal(matchesFilter(undefined, only('changes')), false, 'not checked yet');
});

test('outside repos, only folders that lead to matching repos are shown', () => {
  const roots = [p('services', 'api'), p('services', 'auth'), p('frontend', 'web')];
  assert.deepEqual(
    filteredEntries(ws, roots, []).map(e => e.name),
    ['frontend', 'services'],
  );
  assert.deepEqual(
    filteredEntries(p('services'), roots, []).map(e => e.name),
    ['api', 'auth'],
  );
});

test('inside a repo, only changed files and the folders that hold them are shown', () => {
  const root = p('services', 'api');
  const changes = [
    {
      root,
      files: [file('README.md'), file('src/index.ts'), file('src/routes/new.ts', 'A', true), file('tmp/', 'U'), file('gone.ts', 'D')],
    },
  ];
  assert.deepEqual(
    filteredEntries(root, [root], changes).map(e => `${e.isDir ? 'dir' : 'file'} ${e.name}${e.change ? ` ${e.change.letter}` : ''}`),
    ['dir src', 'dir tmp U', 'file gone.ts D', 'file README.md M'],
  );
  assert.deepEqual(
    filteredEntries(path.join(root, 'src'), [root], changes).map(e => `${e.isDir ? 'dir' : 'file'} ${e.name}`),
    ['dir routes', 'file index.ts'],
  );
  assert.deepEqual(
    filteredEntries(path.join(root, 'src', 'routes'), [root], changes).map(e => e.name),
    ['new.ts'],
  );
});

test('describeChange', () => {
  assert.equal(describeChange(file('a', '!')), 'conflict');
  assert.equal(describeChange(file('a', 'D')), 'deleted');
  assert.equal(describeChange(file('a', 'A', true)), 'staged');
  assert.equal(describeChange({ ...file('a'), staged: true, unstaged: true }), 'partly staged');
  assert.equal(describeChange(file('a')), undefined);
});
