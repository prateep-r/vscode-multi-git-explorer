import { GitError, runGit, type GitOptions } from './git';

export interface LocalBranch {
  name: string;
  upstream?: string;
  ahead: number;
  behind: number;
  /** The upstream branch was deleted on the remote. */
  gone: boolean;
  /** When its last commit was made, like "3 days ago". */
  when: string;
}

export interface RemoteBranch {
  /** Like "origin/feat/payments". */
  name: string;
  /** The local name it would get, like "feat/payments". */
  localName: string;
  when: string;
}

export interface Branches {
  local: LocalBranch[];
  /** Only remote branches that have no local branch of the same name. */
  remote: RemoteBranch[];
}

const FORMAT = '%(refname)%00%(upstream:short)%00%(upstream:track)%00%(committerdate:relative)';

/** Parses `git for-each-ref --sort=-committerdate --format=<FORMAT>` for heads and remotes. */
export function parseRefs(output: string): Branches {
  const local: LocalBranch[] = [];
  const remotes: RemoteBranch[] = [];
  for (const line of output.split('\n')) {
    if (!line) continue;
    const [ref, upstream, track, when] = line.split('\0');
    if (ref.startsWith('refs/heads/')) {
      const ahead = /ahead (\d+)/.exec(track);
      const behind = /behind (\d+)/.exec(track);
      local.push({
        name: ref.slice('refs/heads/'.length),
        upstream: upstream || undefined,
        ahead: ahead ? Number(ahead[1]) : 0,
        behind: behind ? Number(behind[1]) : 0,
        gone: track === '[gone]',
        when,
      });
    } else if (ref.startsWith('refs/remotes/') && !ref.endsWith('/HEAD')) {
      const name = ref.slice('refs/remotes/'.length);
      remotes.push({ name, localName: name.slice(name.indexOf('/') + 1), when });
    }
  }
  const localNames = new Set(local.map(b => b.name));
  return { local, remote: remotes.filter(r => !localNames.has(r.localName)) };
}

export async function listBranches(root: string, options?: GitOptions): Promise<Branches> {
  const output = await runGit(
    root,
    ['for-each-ref', '--sort=-committerdate', `--format=${FORMAT}`, 'refs/heads', 'refs/remotes'],
    options,
  );
  return parseRefs(output);
}

export type SwitchResult =
  | { ok: true }
  /** Local changes would be overwritten; the user can stash them and retry. */
  | { ok: false; blockedByChanges: true; message: string }
  | { ok: false; blockedByChanges: false; message: string };

/**
 * Switches to a local branch, a remote branch (creating a local one that
 * tracks it), or a new branch (`create`, optionally starting at `from`).
 */
export async function switchBranch(
  root: string,
  target: { local: string } | { remote: string } | { create: string; from?: string },
  options?: GitOptions,
): Promise<SwitchResult> {
  const args =
    'local' in target
      ? ['switch', target.local]
      : 'remote' in target
        ? ['switch', '--track', target.remote]
        : ['switch', '-c', target.create, ...(target.from ? [target.from] : [])];
  try {
    await runGit(root, args, options);
    return { ok: true };
  } catch (error) {
    const stderr = error instanceof GitError ? error.stderr : String(error);
    const message = error instanceof Error ? error.message : String(error);
    const blockedByChanges = /would be overwritten|commit your changes or stash them/i.test(stderr);
    return { ok: false, blockedByChanges, message };
  }
}

/** Stashes all local changes, including untracked files. Returns false if there was nothing to stash. */
export async function stashChanges(root: string, message: string, options?: GitOptions): Promise<boolean> {
  const output = await runGit(root, ['stash', 'push', '--include-untracked', '-m', message], options);
  return !/No local changes to save/i.test(output);
}

/** Whether `name` is a valid new branch name, by git's own rules. */
export async function isValidBranchName(root: string, name: string, options?: GitOptions): Promise<boolean> {
  try {
    await runGit(root, ['check-ref-format', '--branch', name], options);
    return true;
  } catch {
    return false;
  }
}
