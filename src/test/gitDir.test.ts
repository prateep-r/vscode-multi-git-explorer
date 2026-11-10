import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFileSync, writeFileSync } from 'fs';
import * as path from 'path';
import { readStatus } from '../core/git';
import { readFingerprint } from '../core/gitDir';
import { git, makeRepo, makeTempDir, write } from './helpers';

let tmp: ReturnType<typeof makeTempDir>;
before(() => (tmp = makeTempDir()));
after(() => tmp.cleanup());

/** A repo pushed to a bare remote, so it has an upstream. */
function repoWithRemote(name: string): { repo: string; remote: string } {
  const remote = path.join(tmp.dir, name, 'remote.git');
  git(tmp.dir, 'init', '-q', '--bare', '-b', 'main', remote);
  const repo = makeRepo(path.join(tmp.dir, name, 'repo'));
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  return { repo, remote };
}

test('readFingerprint stays the same while nothing changes, even across a status check', async () => {
  const { repo } = repoWithRemote('same');
  write(path.join(repo, 'README.md'), 'edited\n');
  const before = await readFingerprint(repo);
  assert.ok(before);
  await readStatus(repo, true);
  assert.equal(await readFingerprint(repo), before);
});

test('readFingerprint changes with what git records in .git', async () => {
  const { repo, remote } = repoWithRemote('changes');
  const steps: [string, () => void][] = [
    ['staging', () => (write(path.join(repo, 'a.txt')), git(repo, 'add', 'a.txt'))],
    ['a commit', () => git(repo, 'commit', '-q', '-m', 'a')],
    ['a push', () => git(repo, 'push', '-q')],
    ['a new branch', () => git(repo, 'checkout', '-q', '-b', 'topic')],
    ['switching back', () => git(repo, 'checkout', '-q', 'main')],
    ['a stash', () => (write(path.join(repo, 'a.txt'), 'b\n'), git(repo, 'stash', '-q'))],
    ['a second stash', () => (write(path.join(repo, 'a.txt'), 'c\n'), git(repo, 'stash', '-q'))],
    ['dropping an older stash', () => git(repo, 'stash', 'drop', '-q', 'stash@{1}')],
    ['a fetch', () => git(repo, 'fetch', '-q')],
    ['a new remote', () => git(repo, 'remote', 'add', 'other', remote)],
  ];
  let last = await readFingerprint(repo);
  for (const [what, step] of steps) {
    step();
    const now = await readFingerprint(repo);
    assert.notEqual(now, last, what);
    last = now;
  }
});

/** A commit on top of HEAD, made without moving HEAD or touching the index. */
function commitAside(repo: string): string {
  const tree = git(repo, 'rev-parse', 'HEAD^{tree}').trim();
  return git(repo, 'commit-tree', tree, '-p', 'HEAD', '-m', 'aside').trim();
}

test('readFingerprint changes when only the upstream moves', async () => {
  const { repo } = repoWithRemote('upstream');
  const before = await readFingerprint(repo);
  // Only the remote-tracking ref moves; a fetch would also write FETCH_HEAD.
  git(repo, 'update-ref', 'refs/remotes/origin/main', commitAside(repo));
  assert.notEqual(await readFingerprint(repo), before);
});

test('readFingerprint follows a branch whose upstream is a local branch', async () => {
  const repo = makeRepo(path.join(tmp.dir, 'local-upstream'));
  git(repo, 'checkout', '-q', '-b', 'topic', '--track', 'main');
  const before = await readFingerprint(repo);
  git(repo, 'update-ref', 'refs/heads/main', commitAside(repo));
  assert.notEqual(await readFingerprint(repo), before);
});

test('readFingerprint changes when a merge stops on a conflict, and is undefined without .git', async () => {
  const repo = makeRepo(path.join(tmp.dir, 'merge'));
  git(repo, 'checkout', '-q', '-b', 'topic');
  write(path.join(repo, 'README.md'), 'topic\n');
  git(repo, 'commit', '-q', '-am', 'topic');
  git(repo, 'checkout', '-q', 'main');
  write(path.join(repo, 'README.md'), 'main\n');
  git(repo, 'commit', '-q', '-am', 'main');
  const before = await readFingerprint(repo);
  assert.throws(() => git(repo, 'merge', '-q', 'topic'));
  assert.notEqual(await readFingerprint(repo), before);

  const detached = makeRepo(path.join(tmp.dir, 'detached'));
  git(detached, 'checkout', '-q', '--detach');
  assert.ok(await readFingerprint(detached), 'a detached HEAD has one too');
  assert.equal(await readFingerprint(path.join(tmp.dir, 'not-a-repo')), undefined);
});

test('readFingerprint changes when .git/info/exclude does, which decides what counts as untracked', async () => {
  const repo = makeRepo(path.join(tmp.dir, 'exclude'));
  const before = await readFingerprint(repo);
  write(path.join(repo, '.git', 'info', 'exclude'), '*.log\n');
  assert.notEqual(await readFingerprint(repo), before);
});

test('readFingerprint follows refs kept in a reftable', async () => {
  const repo = path.join(tmp.dir, 'reftable');
  git(tmp.dir, 'init', '-q', '-b', 'main', '--ref-format=reftable', repo);
  write(path.join(repo, 'README.md'));
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  const before = await readFingerprint(repo);
  git(repo, 'update-ref', 'refs/remotes/origin/main', commitAside(repo));
  assert.notEqual(await readFingerprint(repo), before);
});

test('readFingerprint finds the upstream however the config writes it', async () => {
  const { repo } = repoWithRemote('config-forms');
  const config = path.join(repo, '.git', 'config');
  // Drop the branch section git wrote, and write it the ways a person might.
  const text = readFileSync(config, 'utf8').replace(/\[branch "main"\][^[]*/, '');
  writeFileSync(config, `${text}[Branch "main"] ; set by hand\n\tRemote = "origin" # where it goes\n\tmerge = refs/heads/main\n[branch "other"]\n\tremote = elsewhere\n`);
  const before = await readFingerprint(repo);
  git(repo, 'update-ref', 'refs/remotes/origin/main', commitAside(repo));
  assert.notEqual(await readFingerprint(repo), before);
});
