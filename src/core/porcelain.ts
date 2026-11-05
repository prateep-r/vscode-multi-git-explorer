export interface BranchInfo {
  detached: boolean;
  /** Branch name. Undefined when HEAD is detached. */
  head?: string;
  /** Current commit. Undefined before the first commit. */
  oid?: string;
  upstream?: string;
  ahead: number;
  behind: number;
}

export interface StatusSummary {
  branch: BranchInfo;
  stash: number;
  /** Files with unstaged changes in the working tree. */
  modified: number;
  /** Files with staged changes. */
  staged: number;
  untracked: number;
  conflicted: number;
  /** Distinct paths with any kind of change. */
  changedFiles: number;
}

/**
 * Parses the output of `git status --porcelain=v2 --branch --show-stash`.
 * See https://git-scm.com/docs/git-status#_porcelain_format_version_2
 */
export function parseStatusV2(output: string): StatusSummary {
  const summary: StatusSummary = {
    branch: { detached: false, ahead: 0, behind: 0 },
    stash: 0,
    modified: 0,
    staged: 0,
    untracked: 0,
    conflicted: 0,
    changedFiles: 0,
  };

  for (const line of output.split('\n')) {
    if (line.startsWith('# ')) {
      parseHeader(line.slice(2), summary);
      continue;
    }
    switch (line[0]) {
      case '1':
      case '2': {
        // "1 XY ..." where X is the index status and Y the working tree status.
        if (line[2] !== '.') summary.staged++;
        if (line[3] !== '.') summary.modified++;
        summary.changedFiles++;
        break;
      }
      case 'u':
        summary.conflicted++;
        summary.changedFiles++;
        break;
      case '?':
        summary.untracked++;
        summary.changedFiles++;
        break;
    }
  }
  return summary;
}

function parseHeader(header: string, summary: StatusSummary): void {
  const space = header.indexOf(' ');
  const key = header.slice(0, space);
  const value = header.slice(space + 1);
  const branch = summary.branch;
  switch (key) {
    case 'branch.oid':
      branch.oid = value === '(initial)' ? undefined : value;
      break;
    case 'branch.head':
      branch.detached = value === '(detached)';
      branch.head = branch.detached ? undefined : value;
      break;
    case 'branch.upstream':
      branch.upstream = value;
      break;
    case 'branch.ab': {
      const match = /^\+(\d+) -(\d+)$/.exec(value);
      if (match) {
        branch.ahead = Number(match[1]);
        branch.behind = Number(match[2]);
      }
      break;
    }
    case 'stash':
      summary.stash = Number(value) || 0;
      break;
  }
}
