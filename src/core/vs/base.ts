/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The few helpers from VS Code's src/vs/base/common that glob.ts, ignoreFile.ts and
// explorerFileNestingTrie.ts use, so those files can be copied unchanged apart from
// their imports. Adapted from microsoft/vscode 1.145.1 (arrays.ts, async.ts, extpath.ts,
// map.ts, path.ts, platform.ts and strings.ts).

import * as path from 'path';

export const { basename, extname, isAbsolute, sep, posix } = path;

export const isLinux = process.platform === 'linux';

export function equals<T>(one: readonly T[] | undefined, other: readonly T[] | undefined, itemEquals: (a: T, b: T) => boolean = (a, b) => a === b): boolean {
  if (one === other) return true;
  if (!one || !other || one.length !== other.length) return false;
  for (let i = 0; i < one.length; i++) if (!itemEquals(one[i], other[i])) return false;
  return true;
}

export function isThenable<T>(obj: unknown): obj is Promise<T> {
  return !!obj && typeof (obj as { then?: unknown }).then === 'function';
}

export function equalsIgnoreCase(a: string, b: string): boolean {
  return a.length === b.length && a.toLowerCase() === b.toLowerCase();
}

export function startsWithIgnoreCase(str: string, candidate: string): boolean {
  return str.length >= candidate.length && equalsIgnoreCase(str.substring(0, candidate.length), candidate);
}

export function endsWithIgnoreCase(str: string, candidate: string): boolean {
  return str.length >= candidate.length && equalsIgnoreCase(str.substring(str.length - candidate.length), candidate);
}

export function escapeRegExpCharacters(value: string): string {
  return value.replace(/[\\{}*+?|^$.[\]()]/g, '\\$&');
}

export function ltrim(haystack: string, needle: string): string {
  if (!haystack || !needle) return haystack;
  let offset = 0;
  while (haystack.indexOf(needle, offset) === offset) offset += needle.length;
  return haystack.substring(offset);
}

export function rtrim(haystack: string, needle: string): string {
  if (!haystack || !needle) return haystack;
  const needleLen = needle.length;
  let offset = haystack.length;
  if (needleLen === 0 || haystack.length === 0) return haystack;
  let idx: number;
  while (offset > 0 && (idx = haystack.lastIndexOf(needle, offset - 1)) !== -1 && idx + needleLen === offset) {
    offset = idx;
    if (offset === 0) return '';
  }
  return haystack.substring(0, offset);
}

/** Whether `candidate` is `base` or a path inside it (extpath.isEqualOrParent). */
export function isEqualOrParent(base: string, parentCandidate: string, ignoreCase?: boolean, separator = sep): boolean {
  if (base === parentCandidate) return true;
  if (!base || !parentCandidate) return false;
  if (parentCandidate.length > base.length) return false;
  if (ignoreCase) {
    if (!startsWithIgnoreCase(base, parentCandidate)) return false;
    if (parentCandidate.length === base.length) return true;
    let sepOffset = parentCandidate.length;
    if (parentCandidate.charAt(parentCandidate.length - 1) === separator) sepOffset--;
    return base.charAt(sepOffset) === separator;
  }
  if (parentCandidate.charAt(parentCandidate.length - 1) !== separator) parentCandidate += separator;
  return base.indexOf(parentCandidate) === 0;
}

/** A Map that keeps at most `limit` entries, dropping the least recently used. */
export class LRUCache<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly limit: number) {}
  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }
  set(key: K, value: V): this {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.limit) this.map.delete(this.map.keys().next().value as K);
    return this;
  }
}

/** The two character codes glob.ts uses, from charCode.ts. */
export const enum CharCode {
  Slash = 47,
  Backslash = 92,
}
