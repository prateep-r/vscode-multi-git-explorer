import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CheapState } from '../core/gitDir';
import type { StatusSummary } from '../core/porcelain';
import { describeRepo, formatAgo, type RepoSnapshot } from '../core/state';

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

function status(overrides: Partial<StatusSummary> = {}, branch: Partial<StatusSummary['branch']> = {}): StatusSummary {
  return {
    stash: 0,
    modified: 0,
    staged: 0,
    untracked: 0,
    conflicted: 0,
    changedFiles: 0,
    ...overrides,
    branch: { detached: false, head: 'main', oid: 'a1b2c3d4e5', upstream: 'origin/main', ahead: 0, behind: 0, ...branch },
  };
}

function snap(s?: StatusSummary, cheap: Partial<CheapState> = {}, extra: Partial<RepoSnapshot> = {}): RepoSnapshot {
  return {
    name: 'api-gateway',
    isSubmodule: false,
    status: s,
    cheap: { branch: 'main', hasRemote: true, lastFetch: NOW - 12 * 60_000, ...cheap },
    ...extra,
  };
}

test('clean and in sync: no badge, quiet description', () => {
  const view = describeRepo(snap(status()), NOW);
  assert.equal(view.kind, 'clean');
  assert.equal(view.group, 'clean');
  assert.equal(view.badge, undefined);
  assert.equal(view.description, '⎇ main');
  assert.match(view.tooltip, /Up to date with origin\/main/);
  assert.match(view.tooltip, /Last fetch: 12 minutes ago/);
});

test('uncommitted changes: badge is the file count, description splits by kind', () => {
  const view = describeRepo(snap(status({ modified: 3, staged: 2, untracked: 1, changedFiles: 6 })), NOW);
  assert.equal(view.kind, 'dirty');
  assert.equal(view.group, 'dirty');
  assert.equal(view.badge, '6');
  assert.equal(view.description, '⎇ main · ●3 +2 ?1');
});

test('more than 9 changed files shows 9+', () => {
  assert.equal(describeRepo(snap(status({ modified: 12, changedFiles: 12 })), NOW).badge, '9+');
});

test('not pushed', () => {
  const view = describeRepo(snap(status({}, { ahead: 2 })), NOW);
  assert.equal(view.kind, 'ahead');
  assert.equal(view.group, 'unpushed');
  assert.equal(view.badge, '↑2');
  assert.equal(view.description, '⎇ main · ↑2');
  assert.match(view.contextValue, /\bcanPush\b/);
});

test('branch never pushed: no upstream', () => {
  const view = describeRepo(snap(status({}, { head: 'fix/login', upstream: undefined }), { branch: 'fix/login' }), NOW);
  assert.equal(view.kind, 'noUpstream');
  assert.equal(view.badge, '↑');
  assert.equal(view.description, '⎇ fix/login · no upstream');
  assert.match(view.contextValue, /\bcanPush\b/);
  assert.doesNotMatch(view.contextValue, /\bupstream\b/);
});

test('local-only repo without a remote is not flagged as unpushed', () => {
  const view = describeRepo(snap(status({}, { upstream: undefined }), { hasRemote: false }), NOW);
  assert.equal(view.kind, 'clean');
  assert.match(view.tooltip, /Local repository/);
  assert.doesNotMatch(view.tooltip, /fetch/i);
});

test('behind and diverged', () => {
  const behind = describeRepo(snap(status({}, { behind: 4 })), NOW);
  assert.equal(behind.kind, 'behind');
  assert.equal(behind.badge, '↓4');
  const diverged = describeRepo(snap(status({}, { ahead: 2, behind: 3 })), NOW);
  assert.equal(diverged.kind, 'diverged');
  assert.equal(diverged.group, 'behind');
  assert.equal(diverged.badge, '↕');
  assert.equal(diverged.description, '⎇ main · ↑2 ↓3');
});

test('conflict wins over everything else', () => {
  const view = describeRepo(
    snap(status({ conflicted: 2, modified: 1, changedFiles: 3 }, { ahead: 1 }), { operation: { kind: 'merge' } }),
    NOW,
  );
  assert.equal(view.kind, 'conflict');
  assert.equal(view.badge, '!');
  assert.equal(view.description, '⎇ main · MERGING · ✕2 · ●1 · ↑1');
});

test('a repo whose only changes are conflicts does not claim to have no changes', () => {
  const view = describeRepo(snap(status({ conflicted: 1, changedFiles: 1 }), { operation: { kind: 'merge' } }), NOW);
  assert.match(view.tooltip, /1 conflicted file/);
  assert.doesNotMatch(view.tooltip, /No local changes/);
});

test('rebase in progress shows the branch being rebased and progress', () => {
  const view = describeRepo(
    snap(status({}, { detached: true, head: undefined }), {
      branch: undefined,
      detachedOid: 'ffff000',
      operation: { kind: 'rebase', step: 3, total: 7, branch: 'feat/sso' },
    }),
    NOW,
  );
  assert.equal(view.kind, 'operation');
  assert.equal(view.group, 'conflict');
  assert.equal(view.badge, 'R');
  assert.equal(view.description, '⎇ feat/sso · REBASING 3/7');
  assert.match(view.tooltip, /Rebase in progress \(step 3 of 7\)/);
});

test('detached HEAD', () => {
  const view = describeRepo(
    snap(status({}, { detached: true, head: undefined, oid: 'a1b2c3d4e5f6' }), { branch: undefined, detachedOid: 'a1b2c3d4e5f6' }),
    NOW,
  );
  assert.equal(view.kind, 'detached');
  assert.equal(view.badge, 'D');
  assert.equal(view.description, '⎇ a1b2c3d (detached)');
});

test('before status arrives the branch from .git is shown right away', () => {
  const view = describeRepo(snap(undefined), NOW);
  assert.equal(view.kind, 'pending');
  assert.equal(view.group, 'checking');
  assert.equal(view.badge, '…');
  assert.equal(view.description, '⎇ main · checking…');
});

test('failed check', () => {
  const view = describeRepo(snap(undefined, {}, { error: 'git status timed out' }), NOW);
  assert.equal(view.kind, 'error');
  assert.equal(view.badge, '⚠');
  assert.match(view.tooltip, /timed out/);
});

test('several states at once: badge picks the most important, description shows all', () => {
  const view = describeRepo(snap(status({ modified: 3, changedFiles: 3, stash: 1 }, { ahead: 2 })), NOW);
  assert.equal(view.badge, '3');
  assert.equal(view.description, '⎇ main · ●3 · ↑2 · ≡1');
});

test('submodules are labelled', () => {
  const view = describeRepo(snap(status(), {}, { isSubmodule: true }), NOW);
  assert.equal(view.description, '⎇ main · submodule');
});

test('every badge fits the two-character limit of file decorations', () => {
  const samples = [
    snap(status({ modified: 99, changedFiles: 99 })),
    snap(status({}, { ahead: 120 })),
    snap(status({}, { behind: 120 })),
    snap(status({}, { ahead: 1, behind: 1 })),
    snap(undefined, {}, { error: 'x' }),
    snap(undefined),
  ];
  for (const sample of samples) {
    const badge = describeRepo(sample, NOW).badge ?? '';
    assert.ok([...badge].length <= 2, `badge "${badge}" is too long`);
  }
});

test('formatAgo', () => {
  assert.equal(formatAgo(NOW - 5_000, NOW), 'just now');
  assert.equal(formatAgo(NOW - 60_000, NOW), '1 minute ago');
  assert.equal(formatAgo(NOW - 2 * 3600_000, NOW), '2 hours ago');
  assert.equal(formatAgo(NOW - 3 * 86400_000, NOW), '3 days ago');
});
