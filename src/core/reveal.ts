import type { ParsedExpression } from './vs/glob';

/** `explorer.autoReveal`: `true`, `false` or `"focusNoScroll"`. Anything but `false` turns it on. */
export function autoRevealOn(value: unknown): boolean {
  return value === true || value === 'focusNoScroll';
}

/**
 * Whether `explorer.autoRevealExclude` keeps a file from being revealed, as
 * the built-in Explorer's `shouldAutoRevealItem` decides: the file matches
 * (with its siblings, for `when` clauses), or any folder above it inside the
 * workspace folder does.
 */
export function isRevealExcluded(matches: ParsedExpression, relPath: string, hasSibling?: (name: string) => boolean): boolean {
  const parts = relPath.split('/').filter(Boolean);
  if (parts.length === 0) return false;
  if (matches(parts.join('/'), parts[parts.length - 1], hasSibling)) return true;
  for (let n = parts.length - 1; n > 0; n--) {
    if (matches(parts.slice(0, n).join('/'), parts[n - 1])) return true;
  }
  return false;
}
