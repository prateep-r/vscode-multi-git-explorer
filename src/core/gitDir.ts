import { promises as fs } from 'fs';
import * as path from 'path';

export type OperationKind = 'merge' | 'rebase' | 'cherry-pick' | 'revert';

export interface Operation {
  kind: OperationKind;
  /** Rebase progress, when git records it. */
  step?: number;
  total?: number;
  /** Branch being rebased. HEAD is detached while a rebase runs. */
  branch?: string;
}

/**
 * Repo state that can be read straight from files in `.git`, without
 * starting a git process. Cheap enough to read for every repo at once.
 */
export interface CheapState {
  branch?: string;
  detachedOid?: string;
  operation?: Operation;
  /** Time of the last fetch (mtime of FETCH_HEAD), in ms. */
  lastFetch?: number;
  hasRemote: boolean;
}

export interface GitDirs {
  /** This worktree's git directory. */
  gitDir: string;
  /** Directory shared by all worktrees (holds config and refs). */
  commonDir: string;
}

/** Resolves `.git`, which is a file pointing elsewhere for worktrees and submodules. */
export async function resolveGitDirs(root: string): Promise<GitDirs | undefined> {
  const dotGit = path.join(root, '.git');
  const stat = await fs.stat(dotGit).catch(() => undefined);
  if (!stat) return undefined;

  let gitDir = dotGit;
  if (stat.isFile()) {
    const match = /^gitdir:\s*(.+)$/m.exec(await readText(dotGit));
    if (!match) return undefined;
    gitDir = path.resolve(root, match[1].trim());
  }
  const common = await readText(path.join(gitDir, 'commondir'));
  const commonDir = common ? path.resolve(gitDir, common.trim()) : gitDir;
  return { gitDir, commonDir };
}

export async function readCheapState(root: string): Promise<CheapState | undefined> {
  const dirs = await resolveGitDirs(root);
  if (!dirs) return undefined;
  const { gitDir, commonDir } = dirs;

  const [head, config, fetchTimes, operation] = await Promise.all([
    readText(path.join(gitDir, 'HEAD')),
    readText(path.join(commonDir, 'config')),
    Promise.all([mtime(path.join(gitDir, 'FETCH_HEAD')), mtime(path.join(commonDir, 'FETCH_HEAD'))]),
    readOperation(gitDir),
  ]);

  const state: CheapState = {
    operation,
    hasRemote: /^\s*\[remote\s+"/m.test(config),
  };
  const ref = /^ref:\s*refs\/heads\/(.+)$/m.exec(head);
  if (ref) {
    state.branch = ref[1].trim();
  } else if (head.trim()) {
    state.detachedOid = head.trim();
  }
  const fetched = fetchTimes.filter((t): t is number => t !== undefined);
  if (fetched.length) state.lastFetch = Math.max(...fetched);
  return state;
}

/** Files in a worktree's git directory that a status check depends on. */
const WORKTREE_FILES = ['HEAD', 'index', 'FETCH_HEAD', 'ORIG_HEAD', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'logs/HEAD'];
/** Files in the directory shared by all worktrees that a status check depends on. */
const SHARED_FILES = ['config', 'packed-refs', 'reftable/tables.list', 'FETCH_HEAD', 'refs/stash', 'logs/refs/stash', 'info/exclude'];

/**
 * A summary of what a status check reads from `.git`: the time, size and
 * inode of HEAD, the index, the branch and its upstream, the stash and the
 * files of an operation in progress. It changes on a commit, checkout,
 * reset, merge, rebase, stash, fetch or push, and reading it starts no
 * process. Changes to the working tree don't show in it; the file watcher
 * reports those. Undefined without `.git`.
 */
export async function readFingerprint(root: string): Promise<string | undefined> {
  const dirs = await resolveGitDirs(root);
  if (!dirs) return undefined;
  const { gitDir, commonDir } = dirs;
  const [head, config] = await Promise.all([readText(path.join(gitDir, 'HEAD')), readText(path.join(commonDir, 'config'))]);
  const files = [...WORKTREE_FILES.map(f => path.join(gitDir, f)), ...SHARED_FILES.map(f => path.join(commonDir, f))];
  const branch = /^ref:\s*(refs\/heads\/.+)$/m.exec(head)?.[1].trim();
  if (branch) {
    files.push(path.join(commonDir, branch));
    const upstream = upstreamRef(config, branch.slice('refs/heads/'.length));
    if (upstream) files.push(path.join(commonDir, upstream));
  }
  const stats = await Promise.all(files.map(f => fs.stat(f).catch(() => undefined)));
  return stats.map(s => (s ? `${s.mtimeMs}:${s.size}:${s.ino}` : '-')).join(' ');
}

/**
 * The ref a branch's upstream is kept in, from the branch's `remote` and
 * `merge` in the git config. Section and key names are matched without
 * case, and comments and quotes are dropped, as git does. Files the config
 * includes aren't read.
 */
function upstreamRef(config: string, branch: string): string | undefined {
  let inBranch = false;
  let remote: string | undefined;
  let merge: string | undefined;
  for (const line of config.split('\n')) {
    const section = /^\s*\[([^\]]*)\]/.exec(line);
    if (section) {
      inBranch = /^\s*branch\s+"(.*)"\s*$/i.exec(section[1])?.[1] === branch;
      continue;
    }
    const entry = inBranch && /^\s*(remote|merge)\s*=\s*("[^"]*"|[^#;]*)/i.exec(line);
    if (!entry) continue;
    const value = entry[2].trim().replace(/^"(.*)"$/, '$1');
    if (entry[1].toLowerCase() === 'remote') remote = value;
    else merge = value;
  }
  if (!remote || !merge?.startsWith('refs/heads/')) return undefined;
  return remote === '.' ? merge : `refs/remotes/${remote}/${merge.slice('refs/heads/'.length)}`;
}

async function readOperation(gitDir: string): Promise<Operation | undefined> {
  const rebaseMerge = path.join(gitDir, 'rebase-merge');
  if (await exists(rebaseMerge)) {
    return {
      kind: 'rebase',
      step: await readInt(path.join(rebaseMerge, 'msgnum')),
      total: await readInt(path.join(rebaseMerge, 'end')),
      branch: await readHeadName(path.join(rebaseMerge, 'head-name')),
    };
  }
  const rebaseApply = path.join(gitDir, 'rebase-apply');
  if (await exists(rebaseApply)) {
    return {
      kind: 'rebase',
      step: await readInt(path.join(rebaseApply, 'next')),
      total: await readInt(path.join(rebaseApply, 'last')),
      branch: await readHeadName(path.join(rebaseApply, 'head-name')),
    };
  }
  if (await exists(path.join(gitDir, 'MERGE_HEAD'))) return { kind: 'merge' };
  if (await exists(path.join(gitDir, 'CHERRY_PICK_HEAD'))) return { kind: 'cherry-pick' };
  if (await exists(path.join(gitDir, 'REVERT_HEAD'))) return { kind: 'revert' };
  return undefined;
}

async function readHeadName(file: string): Promise<string | undefined> {
  const name = (await readText(file)).trim();
  return name.startsWith('refs/heads/') ? name.slice('refs/heads/'.length) : undefined;
}

/** A file's text, or '' when it can't be read. */
async function readText(file: string): Promise<string> {
  return fs.readFile(file, 'utf8').catch(() => '');
}

async function readInt(file: string): Promise<number | undefined> {
  const value = Number((await readText(file)).trim());
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

async function mtime(file: string): Promise<number | undefined> {
  return (await fs.stat(file).catch(() => undefined))?.mtimeMs;
}

async function exists(file: string): Promise<boolean> {
  return (await fs.stat(file).catch(() => undefined)) !== undefined;
}
