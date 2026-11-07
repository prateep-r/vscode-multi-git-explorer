import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import * as path from 'path';
import { isValidBranchName, listBranches, parseRefs, stashChanges, switchBranch } from '../core/branches';
import { git, makeRepo, makeTempDir, write } from './helpers';

let tmp: ReturnType<typeof makeTempDir>;
before(() => (tmp = makeTempDir()));
after(() => tmp.cleanup());

test('parseRefs reads tracking info and hides remote branches that are already local', () => {
  const lines = [
    ['refs/heads/feat/sso', 'origin/feat/sso', '[ahead 2]', '2 hours ago', '*'],
    ['refs/heads/main', 'origin/main', '[ahead 1, behind 4]', '3 days ago', ' '],
    ['refs/heads/old', 'origin/old', '[gone]', '1 year ago', ' '],
    ['refs/heads/local-only', '', '', '1 week ago', ' '],
    ['refs/remotes/origin/HEAD', '', '', '3 days ago', ' '],
    ['refs/remotes/origin/main', '', '', '3 days ago', ' '],
    ['refs/remotes/origin/feat/payments', '', '', '5 hours ago', ' '],
  ];
  const branches = parseRefs(lines.map(l => l.join('\0')).join('\n') + '\n');
  assert.deepEqual(branches.local, [
    { name: 'feat/sso', upstream: 'origin/feat/sso', ahead: 2, behind: 0, gone: false, when: '2 hours ago', current: true },
    { name: 'main', upstream: 'origin/main', ahead: 1, behind: 4, gone: false, when: '3 days ago', current: false },
    { name: 'old', upstream: 'origin/old', ahead: 0, behind: 0, gone: true, when: '1 year ago', current: false },
    { name: 'local-only', upstream: undefined, ahead: 0, behind: 0, gone: false, when: '1 week ago', current: false },
  ]);
  assert.deepEqual(branches.remote, [{ name: 'origin/feat/payments', localName: 'feat/payments', when: '5 hours ago' }]);
});

test('switching to local, remote and new branches in a real repo', async () => {
  const remote = path.join(tmp.dir, 'remote.git');
  git(tmp.dir, 'init', '-q', '--bare', '-b', 'main', remote);
  const seed = makeRepo(path.join(tmp.dir, 'seed'));
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', '-u', 'origin', 'main');
  git(seed, 'switch', '-q', '-c', 'feat/payments');
  git(seed, 'push', '-q', '-u', 'origin', 'feat/payments');

  const repo = path.join(tmp.dir, 'clone');
  git(tmp.dir, 'clone', '-q', remote, repo);
  git(repo, 'switch', '-q', '-c', 'topic');

  let branches = await listBranches(repo);
  assert.deepEqual(branches.local.map(b => b.name).sort(), ['main', 'topic']);
  assert.deepEqual(branches.remote.map(b => b.name), ['origin/feat/payments']);

  assert.deepEqual(await switchBranch(repo, { local: 'main' }), { ok: true });
  assert.equal(git(repo, 'branch', '--show-current').trim(), 'main');

  assert.deepEqual(await switchBranch(repo, { remote: 'origin/feat/payments' }), { ok: true });
  assert.equal(git(repo, 'branch', '--show-current').trim(), 'feat/payments');
  assert.equal(git(repo, 'rev-parse', '--abbrev-ref', '@{u}').trim(), 'origin/feat/payments', 'tracks the remote');

  assert.deepEqual(await switchBranch(repo, { create: 'fix/x', from: 'main' }), { ok: true });
  assert.equal(git(repo, 'branch', '--show-current').trim(), 'fix/x');

  branches = await listBranches(repo);
  assert.deepEqual(branches.remote, [], 'remote branch is local now');
});

test('switching is blocked by conflicting local changes until they are stashed', async () => {
  const repo = makeRepo(path.join(tmp.dir, 'blocked'));
  git(repo, 'switch', '-q', '-c', 'other');
  write(path.join(repo, 'README.md'), 'other\n');
  git(repo, 'commit', '-qam', 'other');
  git(repo, 'switch', '-q', 'main');
  write(path.join(repo, 'README.md'), 'uncommitted\n');

  const blocked = await switchBranch(repo, { local: 'other' });
  assert.equal(blocked.ok, false);
  assert.equal(!blocked.ok && blocked.blockedByChanges, true);

  assert.equal(await stashChanges(repo, 'before switching'), true);
  assert.deepEqual(await switchBranch(repo, { local: 'other' }), { ok: true });
  assert.match(git(repo, 'stash', 'list'), /before switching/);
  assert.equal(await stashChanges(repo, 'nothing'), false, 'nothing left to stash');
});

test('isValidBranchName uses git rules', async () => {
  const repo = makeRepo(path.join(tmp.dir, 'names'));
  assert.equal(await isValidBranchName(repo, 'feat/new-thing'), true);
  assert.equal(await isValidBranchName(repo, 'has space'), false);
  assert.equal(await isValidBranchName(repo, 'bad..name'), false);
});

test('a new branch made without a starting point starts at HEAD', async () => {
  const { dir, cleanup } = makeTempDir();
  try {
    const repo = makeRepo(path.join(dir, 'repo'));
    assert.deepEqual(await switchBranch(repo, { create: 'from-head' }), { ok: true });
    assert.equal(git(repo, 'branch', '--show-current').trim(), 'from-head');
  } finally {
    cleanup();
  }
});
