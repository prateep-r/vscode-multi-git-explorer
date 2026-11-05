import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseStatusV2 } from '../core/porcelain';

test('parses branch headers and counts changes by kind', () => {
  const output = [
    '# branch.oid 1234567890abcdef1234567890abcdef12345678',
    '# branch.head main',
    '# branch.upstream origin/main',
    '# branch.ab +2 -3',
    '# stash 1',
    '1 .M N... 100644 100644 100644 aaa aaa src/a.ts',
    '1 M. N... 100644 100644 100644 aaa bbb src/b.ts',
    '1 MM N... 100644 100644 100644 aaa bbb src/c.ts',
    '2 R. N... 100644 100644 100644 aaa aaa R100 new.ts\told.ts',
    'u UU N... 100644 100644 100644 100644 aaa bbb ccc src/d.ts',
    '? notes.txt',
    '! ignored.log',
    '',
  ].join('\n');

  assert.deepEqual(parseStatusV2(output), {
    branch: {
      detached: false,
      head: 'main',
      oid: '1234567890abcdef1234567890abcdef12345678',
      upstream: 'origin/main',
      ahead: 2,
      behind: 3,
    },
    stash: 1,
    modified: 2,
    staged: 3,
    untracked: 1,
    conflicted: 1,
    changedFiles: 6,
  });
});

test('detached HEAD has no branch name', () => {
  const status = parseStatusV2('# branch.oid abc1234\n# branch.head (detached)\n');
  assert.equal(status.branch.detached, true);
  assert.equal(status.branch.head, undefined);
  assert.equal(status.branch.oid, 'abc1234');
});

test('repo without commits has no oid', () => {
  const status = parseStatusV2('# branch.oid (initial)\n# branch.head main\n? a.txt\n');
  assert.equal(status.branch.oid, undefined);
  assert.equal(status.branch.head, 'main');
  assert.equal(status.changedFiles, 1);
});
