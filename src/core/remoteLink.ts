/** Runs git in the repo and returns its trimmed output, or '' when it fails. */
export type GitReader = (args: string[]) => Promise<string>;

export interface HeadState {
  /** Current branch; undefined when detached. */
  branch?: string;
  /** Current commit, when known. */
  oid?: string;
}

export interface RemoteTarget {
  /** The remote's URL, as `git remote get-url` gives it. */
  url: string;
  /** Branch name or commit to link to. */
  ref: string;
  isCommit: boolean;
  /** Explains a link that doesn't point at the current branch. */
  note?: string;
}

/** The remote a command uses when the branch has none: `origin`, or else the first one. */
export function defaultRemote(remotes: readonly string[]): string | undefined {
  return remotes.includes('origin') ? 'origin' : remotes[0];
}

/**
 * Which remote, and which branch or commit on it, a web link should point to:
 *
 * - a branch with an upstream links to the upstream branch;
 * - a branch pushed without `-u` links to the branch of the same name on the remote;
 * - a branch that was never pushed links to the remote's default branch, with a note;
 * - a detached HEAD links to its commit.
 */
export async function resolveRemoteTarget(git: GitReader, head: HeadState): Promise<RemoteTarget | undefined> {
  const { branch } = head;
  let remote = branch ? await git(['config', '--get', `branch.${branch}.remote`]) : '';
  let ref = '';
  if (remote && remote !== '.') {
    ref = (await git(['config', '--get', `branch.${branch}.merge`])).replace(/^refs\/heads\//, '');
  } else {
    remote = defaultRemote((await git(['remote'])).split('\n').filter(Boolean)) ?? '';
  }
  if (!remote) return undefined;

  let isCommit = false;
  let note: string | undefined;
  if (!branch) {
    ref = head.oid || (await git(['rev-parse', 'HEAD']));
    isCommit = true;
  } else if (!ref) {
    if (await git(['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${branch}`])) {
      ref = branch;
    } else {
      const defaultRef = await git(['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`]);
      ref = defaultRef.startsWith(`${remote}/`) ? defaultRef.slice(remote.length + 1) : '';
      if (ref && ref !== branch) note = `${branch} isn't pushed, so the link points to ${ref}.`;
      ref ||= branch;
    }
  }
  if (!ref) return undefined;

  const url = await git(['remote', 'get-url', remote]);
  return url ? { url, ref, isCommit, note } : undefined;
}
