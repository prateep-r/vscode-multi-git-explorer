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
  files: ChangedFile[];
}

/** The same letters VS Code's Git uses: Modified, Added, Deleted, Renamed, Untracked, and ! for conflicts. */
export type ChangeLetter = 'M' | 'A' | 'D' | 'R' | 'U' | '!';

export interface ChangedFile {
  /** Relative to the repo root, with forward slashes. Untracked folders end with "/". */
  path: string;
  /** Path before a rename. */
  origPath?: string;
  letter: ChangeLetter;
  staged: boolean;
  /** Has changes in the working tree that are not staged. */
  unstaged: boolean;
}

/**
 * Parses the output of `git status --porcelain=v2 -z --branch --show-stash`.
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
    files: [],
  };

  const records = output.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.startsWith('# ')) {
      parseHeader(record.slice(2), summary);
      continue;
    }
    switch (record[0]) {
      case '1':
      case '2': {
        // "1 XY sub mH mI mW hH hI path"; "2 ..." adds a score field, and the
        // original path follows as its own record.
        const x = record[2];
        const y = record[3];
        const path = fieldsAfter(record, record[0] === '1' ? 8 : 9);
        const origPath = record[0] === '2' ? records[++i] : undefined;
        if (x !== '.') summary.staged++;
        if (y !== '.') summary.modified++;
        summary.changedFiles++;
        summary.files.push({
          path,
          ...(origPath !== undefined && { origPath }),
          letter: x === 'D' || y === 'D' ? 'D' : x === 'A' ? 'A' : record[0] === '2' ? 'R' : 'M',
          staged: x !== '.',
          unstaged: y !== '.',
        });
        break;
      }
      case 'u':
        summary.conflicted++;
        summary.changedFiles++;
        summary.files.push({ path: fieldsAfter(record, 10), letter: '!', staged: false, unstaged: true });
        break;
      case '?': {
        const path = record.slice(2);
        summary.untracked++;
        // After `git rm --cached`, the file is both deleted from the index and
        // untracked on disk. It's still there, so show it as untracked.
        const removed = summary.files.find(f => f.path === path && f.letter === 'D' && f.staged);
        if (removed) {
          removed.letter = 'U';
          removed.unstaged = true;
          break;
        }
        summary.changedFiles++;
        summary.files.push({ path, letter: 'U', staged: false, unstaged: true });
        break;
      }
    }
  }
  return summary;
}

/** The rest of a record after its first `count` space-separated fields (paths may contain spaces). */
function fieldsAfter(record: string, count: number): string {
  let index = 0;
  for (let n = 0; n < count; n++) index = record.indexOf(' ', index) + 1;
  return record.slice(index);
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
