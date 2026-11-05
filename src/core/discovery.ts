import { promises as fs } from 'fs';
import * as path from 'path';
import { runPool } from './queue';

export interface DiscoveryOptions {
  /** Folder levels below each root to search. */
  maxDepth: number;
  /** Folder names that are never searched. */
  exclude: ReadonlySet<string>;
}

export interface FoundRepo {
  root: string;
  isSubmodule: boolean;
}

export interface DiscoveryResult {
  repos: FoundRepo[];
  /** Folders whose contents were fully searched (or that are repos). */
  scannedDirs: string[];
}

const READDIR_CONCURRENCY = 32;

/**
 * Finds git repos below `roots`, breadth first. Does not look inside a repo
 * once found (except for its submodules), but always looks inside the roots
 * themselves, so a workspace folder that is a repo still shows nested repos.
 */
export async function discoverRepos(roots: readonly string[], options: DiscoveryOptions): Promise<DiscoveryResult> {
  const repos: FoundRepo[] = [];
  const scannedDirs: string[] = [];
  let level = roots.map(dir => ({ dir, depth: 0 }));

  while (level.length > 0) {
    const next: { dir: string; depth: number }[] = [];
    await runPool(level, READDIR_CONCURRENCY, async ({ dir, depth }) => {
      if (depth >= options.maxDepth && depth > 0) {
        if (await hasDotGit(dir)) {
          repos.push({ root: dir, isSubmodule: false });
          scannedDirs.push(dir);
          repos.push(...(await findSubmodules(dir)));
        }
        return;
      }

      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => undefined);
      if (!entries) return;
      scannedDirs.push(dir);

      if (entries.some(e => e.name === '.git')) {
        repos.push({ root: dir, isSubmodule: false });
        repos.push(...(await findSubmodules(dir)));
        if (depth > 0) return;
      }
      if (depth >= options.maxDepth) return;
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && !options.exclude.has(entry.name)) {
          next.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
        }
      }
    });
    level = next;
  }

  const unique = new Map(repos.map(r => [r.root, r]));
  return { repos: [...unique.values()], scannedDirs };
}

async function hasDotGit(dir: string): Promise<boolean> {
  return (await fs.stat(path.join(dir, '.git')).catch(() => undefined)) !== undefined;
}

async function findSubmodules(repoRoot: string): Promise<FoundRepo[]> {
  const text = await fs.readFile(path.join(repoRoot, '.gitmodules'), 'utf8').catch(() => undefined);
  if (!text) return [];
  const found: FoundRepo[] = [];
  for (const match of text.matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)) {
    const root = path.join(repoRoot, match[1]);
    if (await hasDotGit(root)) found.push({ root, isSubmodule: true });
  }
  return found;
}
