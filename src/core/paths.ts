import * as path from 'path';

/** `dir` with one path separator at the end. Drive roots such as `D:\` and `/` already have one. */
function withSep(dir: string): string {
  return dir.endsWith(path.sep) ? dir : dir + path.sep;
}

/** Whether `fsPath` is strictly inside the folder `dir`. */
export function isInside(fsPath: string, dir: string): boolean {
  return fsPath !== dir && fsPath.startsWith(withSep(dir));
}

/** Whether `fsPath` is the folder `dir` or inside it. */
export function isAtOrInside(fsPath: string, dir: string): boolean {
  return fsPath === dir || isInside(fsPath, dir);
}

/** `fsPath` relative to a repo root, with forward slashes, as git writes paths. Empty for the root itself. */
export function repoRelative(root: string, fsPath: string): string {
  return path.relative(root, fsPath).split(path.sep).join('/');
}

/** The first folder name of `fsPath` below `dir`, which must contain it. */
export function firstPartBelow(fsPath: string, dir: string): string {
  return fsPath.slice(withSep(dir).length).split(path.sep)[0];
}

/**
 * A folder path as a literal pattern for the Search view's "files to include",
 * where `*`, `?`, `[` and braces have glob meanings. Each is wrapped in a
 * character class, so a Next.js folder like `app/[id]` matches itself.
 */
export function literalGlob(text: string): string {
  return text.replace(/[*?[{}]/g, c => `[${c}]`);
}
