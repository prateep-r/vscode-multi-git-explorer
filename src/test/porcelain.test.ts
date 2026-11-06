import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseStatusV2 } from '../core/porcelain';

test('parses branch headers, counts changes by kind and lists changed files', () => {
  const output = [
    '# branch.oid 1234567890abcdef1234567890abcdef12345678',
    '# branch.head main',
    '# branch.upstream origin/main',
    '# branch.ab +2 -3',
    '# stash 1',
    '1 .M N... 100644 100644 100644 aaa aaa src/a.ts',
    '1 M. N... 100644 100644 100644 aaa bbb src/b.ts',
    '1 MM N... 100644 100644 100644 aaa bbb src/with space.ts',
    '1 A. N... 000000 100644 100644 000 bbb added.ts',
    '1 .D N... 100644 100644 000000 aaa aaa gone.ts',
    '2 R. N... 100644 100644 100644 aaa aaa R100 new.ts',
    'old.ts',
    'u UU N... 100644 100644 100644 100644 aaa bbb ccc src/d.ts',
    '? notes.txt',
    '? newdir/',
    '! ignored.log',
    '',
  ].join('\0');

  const status = parseStatusV2(output);
  assert.deepEqual(status.branch, {
    detached: false,
    head: 'main',
    oid: '1234567890abcdef1234567890abcdef12345678',
    upstream: 'origin/main',
    ahead: 2,
    behind: 3,
  });
  assert.equal(status.stash, 1);
  assert.equal(status.modified, 3);
  assert.equal(status.staged, 4);
  assert.equal(status.untracked, 2);
  assert.equal(status.conflicted, 1);
  assert.equal(status.changedFiles, 9);
  assert.equal(status.files.find(f => f.letter === 'R')?.origPath, 'old.ts');
  assert.deepEqual(
    status.files.map(f => `${f.letter} ${f.path}${f.staged ? ' staged' : ''}${f.unstaged ? ' unstaged' : ''}`),
    [
      'M src/a.ts unstaged',
      'M src/b.ts staged',
      'M src/with space.ts staged unstaged',
      'A added.ts staged',
      'D gone.ts unstaged',
      'R new.ts staged',
      '! src/d.ts unstaged',
      'U notes.txt unstaged',
      'U newdir/ unstaged',
    ],
  );
});

test('detached HEAD has no branch name', () => {
  const status = parseStatusV2('# branch.oid abc1234\0# branch.head (detached)\0');
  assert.equal(status.branch.detached, true);
  assert.equal(status.branch.head, undefined);
  assert.equal(status.branch.oid, 'abc1234');
});

test('repo without commits has no oid', () => {
  const status = parseStatusV2('# branch.oid (initial)\0# branch.head main\0? a.txt\0');
  assert.equal(status.branch.oid, undefined);
  assert.equal(status.branch.head, 'main');
  assert.equal(status.changedFiles, 1);
});

test('a file removed with git rm --cached shows once, as untracked', () => {
  const status = parseStatusV2(
    ['# branch.oid abc', '# branch.head main', '1 D. N... 100644 000000 000000 abc 000 f.txt', '? f.txt', ''].join('\0'),
  );
  assert.deepEqual(status.files, [{ path: 'f.txt', letter: 'U', staged: true, unstaged: true }]);
  assert.equal(status.changedFiles, 1);
});
