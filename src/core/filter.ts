import * as path from 'path';
import type { ChangedFile, StatusSummary } from './porcelain';

export type ExplorerFilter = 'changes' | 'unpushed' | 'behind';

export const FILTER_LABELS: Record<ExplorerFilter, string> = {
  changes: 'Changed files',
  unpushed: 'Not pushed',
  behind: 'Behind remote',
};

/** `hasRemote` false means a local-only repo, whose branch having no upstream is not "unpushed". */
export function matchesFilter(
  status: StatusSummary | undefined,
  filters: ReadonlySet<ExplorerFilter>,
  hasRemote = true,
): boolean {
  if (!status) return false;
  const { branch } = status;
  const neverPushed = hasRemote && !branch.detached && !branch.upstream && branch.oid !== undefined;
  return (
    (filters.has('changes') && status.changedFiles > 0) ||
    (filters.has('unpushed') && (branch.ahead > 0 || neverPushed)) ||
    (filters.has('behind') && branch.behind > 0)
  );
}

export interface FilteredEntry {
  name: string;
  isDir: boolean;
  /** Set for a changed file, or a whole untracked folder. */
  change?: ChangedFile;
}

/**
 * What a folder shows when the Repo Explorer is filtered: the folders that
 * lead to matching repos, and inside a repo, only its changed files and the
 * folders that contain them.
 */
export function filteredEntries(
  dir: string,
  matchingRoots: readonly string[],
  changes: readonly { root: string; files: readonly ChangedFile[] }[],
): FilteredEntry[] {
  const entries = new Map<string, FilteredEntry>();
  const addDir = (name: string, change?: ChangedFile) => {
    const existing = entries.get(name);
    if (!existing?.isDir) entries.set(name, { name, isDir: true, change: change ?? existing?.change });
  };

  const prefix = dir + path.sep;
  for (const root of matchingRoots) {
    if (root.startsWith(prefix)) addDir(root.slice(prefix.length).split(path.sep)[0]);
  }

  for (const { root, files } of changes) {
    if (dir !== root && !dir.startsWith(root + path.sep)) continue;
    const relDir = path.relative(root, dir).split(path.sep).join('/');
    const filePrefix = relDir ? `${relDir}/` : '';
    for (const file of files) {
      if (!file.path.startsWith(filePrefix)) continue;
      const rest = file.path.slice(filePrefix.length);
      const slash = rest.indexOf('/');
      if (rest === '') continue;
      if (slash === -1) {
        if (!entries.has(rest)) entries.set(rest, { name: rest, isDir: false, change: file });
      } else if (slash === rest.length - 1) {
        addDir(rest.slice(0, -1), file);
      } else {
        addDir(rest.slice(0, slash));
      }
    }
  }

  return [...entries.values()].sort(
    (a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, undefined, { numeric: true }),
  );
}

/** A short word for a changed file, shown after its name. */
export function describeChange(change: ChangedFile): string | undefined {
  if (change.letter === '!') return 'conflict';
  if (change.letter === 'D') return 'deleted';
  if (change.staged && change.unstaged) return 'partly staged';
  if (change.staged) return 'staged';
  return undefined;
}
