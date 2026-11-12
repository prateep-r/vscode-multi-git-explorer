// Running one git command in many repos at once, from a folder row or a
// group row: which repos it applies to, how a repo's failure counts, and the
// message that sums up the run. Nothing here starts git.
import type { CheapState } from './gitDir';
import type { StatusSummary } from './porcelain';

export type BulkAction = 'fetch' | 'pull' | 'push' | 'refresh';

/** What `reposFor` reads of a repo; `RepoEntry` has it all. */
export interface BulkRepo {
  name: string;
  cheap?: CheapState;
  status?: StatusSummary;
  view: { contextValue: string };
}

export interface BulkOutcome {
  name: string;
  result: 'done' | 'skipped' | 'failed';
  /** git's output, for Show Details. */
  detail?: string;
}

/**
 * The repos an action applies to, from what is already known about them, so
 * choosing starts no git process: the state read from `.git` is there for
 * every repo, the status only for repos checked already (in a large
 * workspace, repos off screen wait for theirs). A pull goes ahead in a repo
 * not checked yet and lets git say whether it has an upstream; a push needs
 * the status, which the caller reads first.
 */
export function reposFor<T extends BulkRepo>(action: BulkAction, repos: readonly T[]): T[] {
  switch (action) {
    case 'fetch':
      return repos.filter(r => r.cheap?.hasRemote);
    case 'pull':
      return repos.filter(r => {
        const { cheap, status } = r;
        if (!cheap?.hasRemote || cheap.operation || cheap.branch === undefined) return false;
        return !status || (!status.branch.detached && status.branch.upstream !== undefined);
      });
    case 'push':
      return repos.filter(r => !r.cheap?.operation && /\bcanPush\b/.test(r.view.contextValue));
    case 'refresh':
      return [...repos];
  }
}

/** git's refusals that leave the repo as it was and need the user, rather than a retry. */
const SKIPPED: Partial<Record<BulkAction, RegExp>> = {
  pull: /Not possible to fast-forward|Diverging branches|would be overwritten by|no tracking information|not currently on a branch/i,
  push: /\[rejected\]|non-fast-forward|fetch first/i,
};

/** Whether a failed git command was a refusal to do something risky (skipped) or an error (failed). */
export function classifyError(action: BulkAction, stderr: string): 'skipped' | 'failed' {
  return SKIPPED[action]?.test(stderr) ? 'skipped' : 'failed';
}

const VERB: Record<BulkAction, string> = { fetch: 'Fetched', pull: 'Pulled', push: 'Pushed', refresh: 'Refreshed' };

const SKIP_REASON: Partial<Record<BulkAction, string>> = {
  pull: ' that would need a merge or has changes in the way',
  push: ' that the remote has newer commits for (pull them first)',
};

/** "no repos", "1 repo", "3 repos". */
export function countRepos(n: number): string {
  return n === 0 ? 'no repos' : `${n} ${n === 1 ? 'repo' : 'repos'}`;
}

/** Names, cut after five, as Fetch All lists them. */
export function nameList(names: readonly string[]): string {
  return names.slice(0, 5).join(', ') + (names.length > 5 ? `, and ${names.length - 5} more` : '');
}

/**
 * The message after a run of `total` repos, of which `outcomes` finished.
 * `warn` is set when something needs a look: a repo skipped or failed, or
 * the run stopped early.
 */
export function summarize(action: BulkAction, outcomes: readonly BulkOutcome[], total: number): { text: string; warn: boolean } {
  const of = (result: BulkOutcome['result']) => outcomes.filter(o => o.result === result).map(o => o.name);
  const skipped = of('skipped');
  const failed = of('failed');
  const stopped = outcomes.length < total;
  const parts = [`${VERB[action]} ${countRepos(of('done').length)}.`];
  if (stopped) parts.unshift(`Stopped after ${outcomes.length} of ${total} repos.`);
  if (skipped.length) parts.push(`Skipped ${skipped.length}${SKIP_REASON[action] ?? ''}: ${nameList(skipped)}.`);
  if (failed.length) parts.push(`Failed ${failed.length}: ${nameList(failed)}.`);
  return { text: parts.join(' '), warn: stopped || skipped.length > 0 || failed.length > 0 };
}
