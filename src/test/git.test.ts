import assert from 'node:assert/strict';
import { writeFileSync } from 'fs';
import { after, before, test } from 'node:test';
import * as path from 'path';
import { discoverRepos } from '../core/discovery';
import { checkIgnore, parseCheckIgnore, readStatus, runGit } from '../core/git';
import { readCheapState } from '../core/gitDir';
import { git, makeRepo, makeTempDir, write } from './helpers';

let tmp: ReturnType<typeof makeTempDir>;
before(() => (tmp = makeTempDir()));
after(() => tmp.cleanup());

test('readStatus reports changes and ahead/behind against a real remote', async () => {
  const remote = path.join(tmp.dir, 'remote.git');
  git(tmp.dir, 'init', '-q', '--bare', '-b', 'main', remote);
  const repo = makeRepo(path.join(tmp.dir, 'status', 'repo'));
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', '-u', 'origin', 'main');

  write(path.join(repo, 'a.txt'));
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-q', '-m', 'local');
  write(path.join(repo, 'README.md'), 'changed\n');
  write(path.join(repo, 'staged.txt'));
  git(repo, 'add', 'staged.txt');
  write(path.join(repo, 'new.txt'));

  const status = await readStatus(repo, true);
  assert.equal(status.branch.head, 'main');
  assert.equal(status.branch.upstream, 'origin/main');
  assert.equal(status.branch.ahead, 1);
  assert.equal(status.branch.behind, 0);
  assert.equal(status.modified, 1);
  assert.equal(status.staged, 1);
  assert.equal(status.untracked, 1);
  assert.equal(status.changedFiles, 3);

  const withoutUntracked = await readStatus(repo, false);
  assert.equal(withoutUntracked.untracked, 0);

  const cheap = await readCheapState(repo);
  assert.equal(cheap?.branch, 'main');
  assert.equal(cheap?.hasRemote, true);
});

test('runGit is unharmed when git exits before reading its input', async () => {
  // Writing to a git that has already exited fails with EPIPE, which must not escape.
  for (let i = 0; i < 5; i++) {
    const output = await runGit(tmp.dir, ['--version'], { input: 'x'.repeat(4 * 1024 * 1024) });
    assert.match(output, /^git version/);
  }
});

test('readCheapState sees detached HEAD and unfinished operations without running git', async () => {
  const repo = makeRepo(path.join(tmp.dir, 'cheap', 'repo'));
  const oid = git(repo, 'rev-parse', 'HEAD').trim();

  git(repo, 'checkout', '-q', '--detach');
  let cheap = await readCheapState(repo);
  assert.equal(cheap?.branch, undefined);
  assert.equal(cheap?.detachedOid, oid);
  assert.equal(cheap?.hasRemote, false);

  writeFileSync(path.join(repo, '.git', 'MERGE_HEAD'), `${oid}\n`);
  cheap = await readCheapState(repo);
  assert.deepEqual(cheap?.operation, { kind: 'merge' });

  write(path.join(repo, '.git', 'rebase-merge', 'msgnum'), '3\n');
  write(path.join(repo, '.git', 'rebase-merge', 'end'), '7\n');
  write(path.join(repo, '.git', 'rebase-merge', 'head-name'), 'refs/heads/feat/sso\n');
  cheap = await readCheapState(repo);
  assert.deepEqual(cheap?.operation, { kind: 'rebase', step: 3, total: 7, branch: 'feat/sso' });
});

test('readCheapState follows the .git file of a linked worktree', async () => {
  const repo = makeRepo(path.join(tmp.dir, 'wt', 'main'));
  const worktree = path.join(tmp.dir, 'wt', 'feature');
  git(repo, 'worktree', 'add', '-q', '-b', 'feature', worktree);
  const cheap = await readCheapState(worktree);
  assert.equal(cheap?.branch, 'feature');
});

test('discoverRepos respects depth, exclusions and submodules', async () => {
  const root = path.join(tmp.dir, 'ws');
  makeRepo(path.join(root, 'services', 'api'));
  makeRepo(path.join(root, 'services', 'auth'));
  makeRepo(path.join(root, 'node_modules', 'pkg'));
  makeRepo(path.join(root, 'deep', 'a', 'b', 'c', 'too-deep'));
  write(path.join(root, 'docs', 'README.md'));

  // A repo inside another repo is only picked up when it is a submodule.
  const parent = makeRepo(path.join(root, 'platform'));
  makeRepo(path.join(parent, 'libs', 'shared'));
  makeRepo(path.join(parent, 'scratch', 'not-a-submodule'));
  write(path.join(parent, '.gitmodules'), '[submodule "shared"]\n\tpath = libs/shared\n\turl = ../shared\n');

  const result = await discoverRepos([root], { maxDepth: 3, exclude: new Set(['node_modules']) });
  const found = result.repos.map(r => [path.relative(root, r.root), r.isSubmodule]).sort();
  assert.deepEqual(found, [
    ['platform', false],
    ['platform/libs/shared', true],
    ['services/api', false],
    ['services/auth', false],
  ]);

  const scanned = new Set(result.scannedDirs.map(d => path.relative(root, d)));
  assert.ok(scanned.has('docs'), 'docs was searched');
  assert.ok(scanned.has('deep/a'), 'deep/a was searched');
  assert.ok(!scanned.has('deep/a/b/c'), 'deep/a/b/c is past the depth limit');
});

test('a workspace folder that is itself a repo still shows nested repos', async () => {
  const root = makeRepo(path.join(tmp.dir, 'rootrepo'));
  makeRepo(path.join(root, 'nested'));
  const result = await discoverRepos([root], { maxDepth: 2, exclude: new Set() });
  assert.deepEqual(result.repos.map(r => path.relative(root, r.root)).sort(), ['', 'nested']);
});

test('checkIgnore reports ignored paths like the git extension, leaving out paths re-included with !', async () => {
  const temp = makeTempDir();
  try {
    const repo = makeRepo(path.join(temp.dir, 'repo'));
    const abs = (rel: string) => path.join(repo, rel);
    write(abs('.gitignore'), 'dist/\n*.log\n!keep.log\n');
    for (const file of ['dist/app.js', 'debug.log', 'keep.log', 'src/a.ts']) write(abs(file), '');
    const ignored = await checkIgnore(repo, ['dist', 'dist/app.js', 'debug.log', 'keep.log', 'src/a.ts'].map(abs));
    assert.deepEqual([...ignored].sort(), ['debug.log', 'dist', 'dist/app.js'].map(abs).sort());
    assert.deepEqual(await checkIgnore(repo, [abs('src/a.ts')]), new Set(), 'exit code 1 means nothing is ignored');
    assert.deepEqual(parseCheckIgnore(''), new Set());
  } finally {
    temp.cleanup();
  }
});

test('runGit reports a git that fails to start, and one that runs too long', async () => {
  await assert.rejects(runGit(tmp.dir, ['status'], { gitPath: path.join(tmp.dir, 'no-such-git') }), (error: Error) => /ENOENT/.test(error.message));
  await assert.rejects(runGit(tmp.dir, ['5'], { gitPath: 'sleep', timeoutMs: 50 }), /git 5 timed out/);
});

test('checkIgnore asks git nothing for no paths', async () => {
  assert.deepEqual(await checkIgnore(path.join(tmp.dir, 'not-a-repo'), []), new Set());
});

test('discoverRepos skips folders it cannot read, and with depth 0 looks at the roots only', async () => {
  const root = path.join(tmp.dir, 'depth0');
  makeRepo(path.join(root, 'inner'));
  assert.deepEqual((await discoverRepos([root], { maxDepth: 0, exclude: new Set() })).repos, []);
  const missing = await discoverRepos([path.join(tmp.dir, 'missing')], { maxDepth: 3, exclude: new Set() });
  assert.deepEqual(missing, { repos: [], scannedDirs: [] });
});

test('readCheapState reads .git by hand: rebases, cherry-picks, reverts, and odd files', async () => {
  const fake = (files: Record<string, string>) => {
    const root = path.join(tmp.dir, 'fake', String(Object.keys(files).length), String(Math.random()).slice(2));
    for (const [name, text] of Object.entries(files)) write(path.join(root, '.git', name), text);
    return root;
  };
  let state = await readCheapState(fake({ HEAD: 'ref: refs/heads/topic\n', 'rebase-apply/next': '2', 'rebase-apply/last': '3', 'rebase-apply/head-name': 'refs/heads/topic' }));
  assert.deepEqual(state?.operation, { kind: 'rebase', step: 2, total: 3, branch: 'topic' });
  assert.equal(state?.hasRemote, false, 'no config file');
  state = await readCheapState(fake({ HEAD: '', 'rebase-merge/msgnum': 'x', 'rebase-merge/end': '0', 'rebase-merge/head-name': 'detached HEAD' }));
  assert.deepEqual(state?.operation, { kind: 'rebase', step: undefined, total: undefined, branch: undefined });
  assert.equal(state?.branch, undefined);
  assert.equal(state?.detachedOid, undefined, 'an empty HEAD is neither');
  assert.deepEqual((await readCheapState(fake({ HEAD: 'ref: refs/heads/main', CHERRY_PICK_HEAD: 'x' })))?.operation, { kind: 'cherry-pick' });
  assert.deepEqual((await readCheapState(fake({ HEAD: 'ref: refs/heads/main', REVERT_HEAD: 'x' })))?.operation, { kind: 'revert' });
  assert.equal((await readCheapState(fake({})))?.branch, undefined, 'no HEAD file');
  assert.equal(await readCheapState(path.join(tmp.dir, 'no-repo-here')), undefined);
  const badLink = path.join(tmp.dir, 'bad-link');
  write(path.join(badLink, '.git'), 'not a gitdir line\n');
  assert.equal(await readCheapState(badLink), undefined, 'a .git file without gitdir:');
  const emptyLink = path.join(tmp.dir, 'empty-link');
  write(path.join(emptyLink, '.git'), '');
  assert.equal(await readCheapState(emptyLink), undefined, 'an empty .git file');
});
