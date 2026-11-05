import type { CheapState, Operation } from './gitDir';
import type { StatusSummary } from './porcelain';

/** The single most important thing about a repo, in priority order. */
export type StateKind =
  | 'error'
  | 'conflict'
  | 'operation'
  | 'dirty'
  | 'detached'
  | 'diverged'
  | 'ahead'
  | 'noUpstream'
  | 'behind'
  | 'pending'
  | 'clean';

export type GroupKey = 'conflict' | 'error' | 'dirty' | 'unpushed' | 'behind' | 'checking' | 'clean';

/** Display order of groups in the Git Repos view. */
export const GROUP_ORDER: GroupKey[] = ['conflict', 'error', 'dirty', 'unpushed', 'behind', 'checking', 'clean'];

export const GROUP_LABELS: Record<GroupKey, string> = {
  conflict: 'Conflict / in progress',
  error: 'Check failed',
  dirty: 'Uncommitted changes',
  unpushed: 'Not pushed',
  behind: 'Behind remote',
  checking: 'Checking…',
  clean: 'Clean',
};

const KIND_GROUP: Record<StateKind, GroupKey> = {
  error: 'error',
  conflict: 'conflict',
  operation: 'conflict',
  dirty: 'dirty',
  detached: 'dirty',
  diverged: 'behind',
  ahead: 'unpushed',
  noUpstream: 'unpushed',
  behind: 'behind',
  pending: 'checking',
  clean: 'clean',
};

export interface RepoSnapshot {
  name: string;
  isSubmodule: boolean;
  cheap?: CheapState;
  status?: StatusSummary;
  error?: string;
}

export interface RepoView {
  kind: StateKind;
  group: GroupKey;
  /** At most two characters, as VS Code requires for file decorations. */
  badge?: string;
  branchLabel: string;
  description: string;
  tooltip: string;
  /** Space-separated flags used by menu `when` clauses. */
  contextValue: string;
  ahead: number;
  behind: number;
}

const OPERATION_BADGE: Record<Operation['kind'], string> = {
  merge: 'M',
  rebase: 'R',
  'cherry-pick': 'C',
  revert: 'V',
};

const OPERATION_LABEL: Record<Operation['kind'], string> = {
  merge: 'MERGING',
  rebase: 'REBASING',
  'cherry-pick': 'CHERRY-PICKING',
  revert: 'REVERTING',
};

export function describeRepo(snap: RepoSnapshot, now = Date.now()): RepoView {
  const { status, cheap } = snap;
  const operation = cheap?.operation;
  const detached = status ? status.branch.detached : cheap ? cheap.branch === undefined : false;
  const oid = status?.branch.oid ?? cheap?.detachedOid;
  const branchName = operation?.branch ?? (status ? status.branch.head : cheap?.branch);
  const branchLabel = branchName ?? (oid ? `${oid.slice(0, 7)} (detached)` : 'unknown');

  const hasRemote = cheap?.hasRemote ?? true;
  const initial = status !== undefined && status.branch.oid === undefined;
  const upstream = status?.branch.upstream;
  const ahead = status?.branch.ahead ?? 0;
  const behind = status?.branch.behind ?? 0;
  const noUpstream = status !== undefined && !detached && !initial && hasRemote && !upstream;

  const kind = pickKind(snap, { detached, ahead, behind, noUpstream });

  return {
    kind,
    group: KIND_GROUP[kind],
    badge: pickBadge(kind, snap, ahead, behind),
    branchLabel,
    description: buildDescription(snap, { kind, branchLabel, ahead, behind, noUpstream, initial }),
    tooltip: buildTooltip(snap, { branchLabel, upstream, ahead, behind, noUpstream, hasRemote, initial, detached }, now),
    contextValue: [
      'repo',
      kind,
      hasRemote && 'remote',
      upstream && 'upstream',
      (ahead > 0 || noUpstream) && 'canPush',
    ]
      .filter(Boolean)
      .join(' '),
    ahead,
    behind,
  };
}

function pickKind(
  snap: RepoSnapshot,
  s: { detached: boolean; ahead: number; behind: number; noUpstream: boolean },
): StateKind {
  const { status, cheap } = snap;
  if (snap.error && !status) return 'error';
  if (status && status.conflicted > 0) return 'conflict';
  if (cheap?.operation) return 'operation';
  if (!status) return 'pending';
  if (status.changedFiles > 0) return 'dirty';
  if (s.detached) return 'detached';
  if (s.ahead > 0 && s.behind > 0) return 'diverged';
  if (s.ahead > 0) return 'ahead';
  if (s.noUpstream) return 'noUpstream';
  if (s.behind > 0) return 'behind';
  return 'clean';
}

function pickBadge(kind: StateKind, snap: RepoSnapshot, ahead: number, behind: number): string | undefined {
  switch (kind) {
    case 'error':
      return '⚠';
    case 'conflict':
      return '!';
    case 'operation':
      return OPERATION_BADGE[snap.cheap!.operation!.kind];
    case 'dirty': {
      const n = snap.status!.changedFiles;
      return n > 9 ? '9+' : String(n);
    }
    case 'detached':
      return 'D';
    case 'diverged':
      return '↕';
    case 'ahead':
      return ahead > 9 ? '↑+' : `↑${ahead}`;
    case 'noUpstream':
      return '↑';
    case 'behind':
      return behind > 9 ? '↓+' : `↓${behind}`;
    case 'pending':
      return '…';
    case 'clean':
      return undefined;
  }
}

function buildDescription(
  snap: RepoSnapshot,
  s: { kind: StateKind; branchLabel: string; ahead: number; behind: number; noUpstream: boolean; initial: boolean },
): string {
  const { status, cheap } = snap;
  const parts = [`⎇ ${s.branchLabel}`];

  const operation = cheap?.operation;
  if (operation) {
    const progress = operation.step && operation.total ? ` ${operation.step}/${operation.total}` : '';
    parts.push(OPERATION_LABEL[operation.kind] + progress);
  }
  if (status) {
    if (status.conflicted) parts.push(`✕${status.conflicted}`);
    const changes = [
      status.modified && `●${status.modified}`,
      status.staged && `+${status.staged}`,
      status.untracked && `?${status.untracked}`,
    ].filter(Boolean);
    if (changes.length) parts.push(changes.join(' '));
    const sync = [s.ahead && `↑${s.ahead}`, s.behind && `↓${s.behind}`].filter(Boolean);
    if (sync.length) parts.push(sync.join(' '));
    if (s.noUpstream) parts.push('no upstream');
    if (s.initial) parts.push('no commits');
    if (status.stash) parts.push(`≡${status.stash}`);
  }
  if (snap.isSubmodule) parts.push('submodule');
  if (s.kind === 'pending') parts.push('checking…');
  if (s.kind === 'error') parts.push('check failed');
  return parts.join(' · ');
}

function buildTooltip(
  snap: RepoSnapshot,
  s: {
    branchLabel: string;
    upstream?: string;
    ahead: number;
    behind: number;
    noUpstream: boolean;
    hasRemote: boolean;
    initial: boolean;
    detached: boolean;
  },
  now: number,
): string {
  const { status, cheap } = snap;
  const lines = [`${snap.name}${snap.isSubmodule ? ' (submodule)' : ''} — ⎇ ${s.branchLabel}`];

  const operation = cheap?.operation;
  if (operation) {
    const progress = operation.step && operation.total ? ` (step ${operation.step} of ${operation.total})` : '';
    lines.push(`${capitalize(operation.kind)} in progress${progress}`);
  }

  if (status) {
    if (s.initial) lines.push('No commits yet');
    else if (s.detached) lines.push('HEAD is detached (not on a branch)');
    else if (!s.hasRemote) lines.push('Local repository (no remote)');
    else if (s.noUpstream) lines.push('Branch has no upstream yet');
    else if (s.ahead || s.behind) {
      const sync = [s.ahead && `${s.ahead} to push`, s.behind && `${s.behind} to pull`].filter(Boolean).join(', ');
      lines.push(`${sync} (${s.upstream})`);
    } else lines.push(`Up to date with ${s.upstream}`);

    if (status.conflicted) lines.push(`${status.conflicted} conflicted ${plural(status.conflicted, 'file')}`);
    const changes = [
      status.modified && `${status.modified} modified`,
      status.staged && `${status.staged} staged`,
      status.untracked && `${status.untracked} untracked`,
    ].filter(Boolean);
    if (changes.length) lines.push(`Changes: ${changes.join(' · ')}`);
    else if (!status.conflicted) lines.push('No local changes');
    if (status.stash) lines.push(`Stash: ${status.stash}`);
  } else if (snap.error) {
    lines.push(`Couldn't read status: ${snap.error}`);
  } else {
    lines.push('Checking…');
  }

  if (s.hasRemote) {
    lines.push(cheap?.lastFetch ? `Last fetch: ${formatAgo(cheap.lastFetch, now)}` : 'Never fetched');
  }
  return lines.join('\n');
}

export function formatAgo(time: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} ${plural(minutes, 'minute')} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${plural(hours, 'hour')} ago`;
  const days = Math.round(hours / 24);
  return `${days} ${plural(days, 'day')} ago`;
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

function capitalize(text: string): string {
  return text[0].toUpperCase() + text.slice(1);
}
