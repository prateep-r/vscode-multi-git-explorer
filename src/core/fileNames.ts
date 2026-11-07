import * as path from 'path';
import { isInside } from './paths';

/**
 * An error message for a name or relative path typed for New File or New
 * Folder in `parent`, or undefined when it's fine. Folders on the way, as in
 * `src/utils/date.ts`, are created too.
 */
export function checkNewPath(parent: string, value: string): string | undefined {
  const name = value.trim().replace(/[\\/]+$/, '');
  if (!name) return undefined;
  if (path.isAbsolute(name)) return 'Enter a name or a relative path.';
  if (!isInside(path.resolve(parent, name), parent)) return 'The new item must be inside this folder.';
  const parts = name.split(/[\\/]/);
  if (parts.some(part => part === '' || part === '.' || part === '..')) return 'Remove the empty, "." or ".." parts from the path.';
  return parts.map(checkNewName).find(Boolean);
}

/** An error message for a new name typed when renaming, or undefined when it's fine. */
export function checkNewName(name: string): string | undefined {
  if (!name.trim()) return 'Enter a name.';
  if (name !== name.trim()) return 'Names can’t start or end with a space.';
  if (/[\\/]/.test(name)) return 'Enter a name, not a path.';
  if (name === '.' || name === '..') return 'This name is reserved.';
  return undefined;
}
