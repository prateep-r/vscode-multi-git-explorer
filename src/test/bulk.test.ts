import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyError, countRepos, reposFor, summarize, type BulkOutcome, type BulkRepo } from '../core/bulk';
import type { StatusSummary } from '../core/porcelain';

function repo(name: string, options: { remote?: boolean; detached?: boolean; operation?: boolean; status?: Partial<StatusSummary['branch']>; flags?: string } = {}): BulkRepo {
  const { remote = true, detached = false, operation = false, status, flags = '' } = options;
  return {
    name,
    cheap: {
      hasRemote: remote,
      ...(detached ? { detachedOid: 'abc' } : { branch: 'main' }),
      ...(operation ? { operation: { kind: 'rebase' as const } } : {}),
    },
    status: status && {
      stash: 0, modified: 0, staged: 0, untracked: 0, conflicted: 0, changedFiles: 0, files: [],
      branch: { detached, head: detached ? undefined : 'main', oid: 'abc', upstream: 'origin/main', ahead: 0, behind: 0, ...status },
    },
    view: { contextValue: `repo clean ${flags}`.trim() },
  };
}

const names = (repos: BulkRepo[]) => repos.map(r => r.name);

test('reposFor fetch takes the repos with a remote', () => {
  assert.deepEqual(names(reposFor('fetch', [repo('a'), repo('b', { remote: false }), repo('c', { detached: true })])), ['a', 'c']);
});

test('reposFor pull takes repos on a branch with an upstream, and repos not checked yet', () => {
  const repos = [
    repo('checked', { status: {} }),
    repo('no-upstream', { status: { upstream: undefined } }),
    repo('unchecked'),
    repo('detached', { detached: true }),
    repo('detached-checked', { detached: true, status: {} }),
    repo('no-remote', { remote: false }),
    repo('rebasing', { operation: true, status: {} }),
    { ...repo('gone'), cheap: undefined },
  ];
  assert.deepEqual(names(reposFor('pull', repos)), ['checked', 'unchecked']);
});

test('reposFor push takes the repos with something to push, outside an operation', () => {
  const repos = [repo('ahead', { flags: 'canPush' }), repo('clean'), repo('rebasing', { operation: true, flags: 'canPush' }), repo('unchecked')];
  assert.deepEqual(names(reposFor('push', repos)), ['ahead']);
});

test('reposFor refresh takes every repo', () => {
  assert.deepEqual(names(reposFor('refresh', [repo('a'), repo('b', { remote: false })])), ['a', 'b']);
});

test('classifyError skips a pull that needs a merge or would overwrite changes', () => {
  for (const stderr of [
    'fatal: Not possible to fast-forward, aborting.',
    "hint: Diverging branches can't be fast-forwarded, you need to either:",
    'error: Your local changes to the following files would be overwritten by merge:\n\tREADME.md',
    'There is no tracking information for the current branch.',
    'You are not currently on a branch.',
  ]) {
    assert.equal(classifyError('pull', stderr), 'skipped', stderr);
  }
  assert.equal(classifyError('pull', 'fatal: unable to access the remote'), 'failed');
});

test('classifyError skips a push the remote rejected for having newer commits', () => {
  assert.equal(classifyError('push', ' ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs'), 'skipped');
  assert.equal(classifyError('push', ' ! [rejected]        main -> main (non-fast-forward)'), 'skipped');
  assert.equal(classifyError('push', 'fatal: Authentication failed'), 'failed');
  assert.equal(classifyError('fetch', 'fatal: Not possible to fast-forward'), 'failed', 'only pull and push skip');
});

const outcome = (name: string, result: BulkOutcome['result']): BulkOutcome => ({ name, result });

test('summarize says how many were done, and stays quiet about what went well', () => {
  assert.deepEqual(summarize('pull', [outcome('a', 'done'), outcome('b', 'done')], 2), { text: 'Pulled 2 repos.', warn: false });
  assert.deepEqual(summarize('fetch', [outcome('a', 'done')], 1), { text: 'Fetched 1 repo.', warn: false });
});

test('summarize lists the skipped and failed repos, five at most', () => {
  const outcomes = [
    outcome('a', 'done'),
    outcome('b', 'skipped'),
    ...['c', 'd', 'e', 'f', 'g', 'h', 'i'].map(n => outcome(n, 'failed')),
  ];
  assert.deepEqual(summarize('pull', outcomes, outcomes.length), {
    text: 'Pulled 1 repo. Skipped 1 that would need a merge or has changes in the way: b. Failed 7: c, d, e, f, g, and 2 more.',
    warn: true,
  });
  assert.equal(
    summarize('push', [outcome('a', 'skipped'), outcome('b', 'skipped')], 2).text,
    'Pushed no repos. Skipped 2 that the remote has newer commits for (pull them first): a, b.',
  );
  assert.equal(summarize('fetch', [outcome('a', 'skipped')], 1).text, 'Fetched no repos. Skipped 1: a.');
});

test('countRepos counts in words', () => {
  assert.deepEqual([0, 1, 2].map(countRepos), ['no repos', '1 repo', '2 repos']);
});

test('summarize says when the run was stopped', () => {
  assert.deepEqual(summarize('fetch', [outcome('a', 'done')], 3), { text: 'Stopped after 1 of 3 repos. Fetched 1 repo.', warn: true });
});
