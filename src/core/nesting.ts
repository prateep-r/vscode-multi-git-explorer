import { ExplorerFileNestingTrie } from './vs/explorerFileNestingTrie';

/**
 * Reads `explorer.fileNesting.patterns` the way the built-in Explorer does
 * (explorerModel.ts): string keys and values only, values split at commas,
 * zero-width spaces dropped, and names lowercased where the disk ignores case.
 */
export function makeNester(patterns: unknown, ignoreCase: boolean): ExplorerFileNestingTrie {
  const name = (s: string) => (ignoreCase ? s.toLowerCase() : s);
  const entries = Object.entries(typeof patterns === 'object' && patterns ? patterns : {})
    .filter((e): e is [string, string] => typeof e[0] === 'string' && typeof e[1] === 'string' && !!e[0] && !!e[1])
    .map(
      ([parent, children]) =>
        [
          name(parent.trim()),
          children
            .split(',')
            .map(p => name(p.trim().replace(/​/g, '').trim()))
            .filter(p => p !== ''),
        ] as [string, string[]],
    );
  return new ExplorerFileNestingTrie(entries);
}

/**
 * Which files of a folder nest under which: each nest parent with the names
 * of the files under it. Files that nest under another aren't keys.
 */
export function nestFiles(nester: ExplorerFileNestingTrie, files: readonly string[], dirName: string, ignoreCase: boolean): Map<string, string[]> {
  const byName = new Map(files.map(f => [ignoreCase ? f.toLowerCase() : f, f]));
  const nested = nester.nest([...byName.keys()], ignoreCase ? dirName.toLowerCase() : dirName);
  const result = new Map<string, string[]>();
  for (const [parent, children] of nested) {
    const original = byName.get(parent);
    if (original === undefined) continue;
    result.set(original, [...children.keys()].map(c => byName.get(c) ?? c));
  }
  return result;
}
