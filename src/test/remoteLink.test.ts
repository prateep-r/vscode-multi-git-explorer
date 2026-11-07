import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultRemote, resolveRemoteTarget, type GitReader } from '../core/remoteLink';

/** A fake git that answers from a table of `args.join(' ')` to output; anything else fails (''). */
function fakeGit(answers: Record<string, string>): GitReader & { asked: string[] } {
  const asked: string[] = [];
  const git = async (args: string[]) => {
    asked.push(args.join(' '));
    return answers[args.join(' ')] ?? '';
  };
  return Object.assign(git, { asked });
}

const URL = 'git@github.com:acme/app.git';

test('defaultRemote prefers origin', () => {
  assert.equal(defaultRemote(['upstream', 'origin']), 'origin');
  assert.equal(defaultRemote(['upstream']), 'upstream');
  assert.equal(defaultRemote([]), undefined);
});

test('a branch with an upstream links to the upstream branch', async () => {
  const git = fakeGit({
    'config --get branch.feat.remote': 'fork',
    'config --get branch.feat.merge': 'refs/heads/feature/x',
    'remote get-url fork': URL,
  });
  assert.deepEqual(await resolveRemoteTarget(git, { branch: 'feat' }), { url: URL, ref: 'feature/x', isCommit: false, note: undefined });
});

test('a branch pushed without -u links to the branch of the same name', async () => {
  const git = fakeGit({
    remote: 'origin',
    'rev-parse --verify --quiet refs/remotes/origin/feat': 'abc123',
    'remote get-url origin': URL,
  });
  assert.deepEqual(await resolveRemoteTarget(git, { branch: 'feat' }), { url: URL, ref: 'feat', isCommit: false, note: undefined });
});

test('a branch never pushed links to the default branch, with a note', async () => {
  const git = fakeGit({
    remote: 'upstream\norigin',
    'symbolic-ref --short refs/remotes/origin/HEAD': 'origin/main',
    'remote get-url origin': URL,
  });
  const target = await resolveRemoteTarget(git, { branch: 'wip' });
  assert.equal(target?.ref, 'main');
  assert.match(target!.note!, /wip isn't pushed, so the link points to main/);
});

test('without a known default branch, the current branch is used', async () => {
  const git = fakeGit({ remote: 'origin', 'remote get-url origin': URL });
  assert.equal((await resolveRemoteTarget(git, { branch: 'main' }))?.ref, 'main');
});

test('a detached HEAD links to its commit', async () => {
  const git = fakeGit({ remote: 'origin', 'remote get-url origin': URL, 'rev-parse HEAD': 'deadbeef' });
  assert.deepEqual(await resolveRemoteTarget(git, { oid: 'abc123' }), { url: URL, ref: 'abc123', isCommit: true, note: undefined });
  assert.equal((await resolveRemoteTarget(git, {}))?.ref, 'deadbeef', 'asks git when the commit is unknown');
});

test('a repo without remotes has no link', async () => {
  assert.equal(await resolveRemoteTarget(fakeGit({}), { branch: 'main' }), undefined);
});

test('a branch tracking a local branch (remote ".") falls back to a real remote', async () => {
  const git = fakeGit({
    'config --get branch.topic.remote': '.',
    remote: 'origin',
    'rev-parse --verify --quiet refs/remotes/origin/topic': 'abc',
    'remote get-url origin': URL,
  });
  assert.equal((await resolveRemoteTarget(git, { branch: 'topic' }))?.ref, 'topic');
});

test('no link without a ref or a URL', async () => {
  assert.equal(await resolveRemoteTarget(fakeGit({ remote: 'origin' }), {}), undefined, 'detached, and HEAD unknown');
  const noUrl = fakeGit({ 'config --get branch.main.remote': 'origin', 'config --get branch.main.merge': 'refs/heads/main' });
  assert.equal(await resolveRemoteTarget(noUrl, { branch: 'main' }), undefined, 'the remote has no URL');
});
