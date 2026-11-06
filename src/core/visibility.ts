import * as glob from './vs/glob';

/**
 * Which rows the file tree shows, decided the way the built-in Explorer's
 * `FilesFilter.isVisible` does (VS Code 1.145): `files.exclude` patterns,
 * including `when` clauses and `!` exceptions, an optional extra "hidden"
 * check (`.gitignore` with `explorer.excludeGitIgnore`), and excluded items
 * that stay shown because an open editor is at or inside them.
 */

/** What a folder's children need to know about it. */
export interface VisibilityState {
  /** Excluded itself, or inside an excluded folder. Shown only for an open editor. */
  isExcluded: boolean;
  /** Excluded, but shown because an exception could match something inside it. */
  leadsToException: boolean;
}

/** The state of a workspace folder, which is never excluded. */
export const ROOT_STATE: VisibilityState = { isExcluded: false, leadsToException: false };

export type ExcludeRules = glob.IParsedExcludeExpression;

/**
 * Parses `files.exclude` for one workspace folder. The setting's value is
 * copied first, as the built-in Explorer does, since parsing keeps it (and
 * VS Code hands it out as a proxy that structuredClone can't copy).
 */
export function parseExcludes(expression: glob.IExpression | undefined): ExcludeRules {
  return glob.parseExcludeExpression(JSON.parse(JSON.stringify(expression ?? {})) as glob.IExpression);
}

export interface EntryToCheck {
  /** Path relative to the workspace folder, with forward slashes. */
  relPath: string;
  name: string;
  isDir: boolean;
  parent: VisibilityState;
  /** Hidden for another reason that exceptions also override, such as `.gitignore`. */
  isHidden?: () => boolean;
  /** For `when` clauses: whether the folder holds an entry with this name. */
  hasSibling?: (name: string) => boolean;
  /** Whether a visible editor shows this item or something inside it. */
  hasEditorInside?: () => boolean;
}

export interface EntryVisibility {
  visible: boolean;
  /** Passed to the children as their `parent`. */
  state: VisibilityState;
  /** Shown only because of an open editor, so the tree must update when that editor closes. */
  shownForEditor: boolean;
}

export function checkEntry(rules: ExcludeRules, entry: EntryToCheck): EntryVisibility {
  const { isExcluded, isVisited } = glob.evaluateExcludeTreeEntry(rules, {
    path: entry.relPath,
    basename: entry.name,
    isDirectory: entry.isDir,
    isParentExcluded: entry.parent.isExcluded || entry.parent.leadsToException,
    isHidden: entry.isHidden,
    hasSibling: entry.hasSibling,
  });
  if (!isExcluded) return { visible: true, state: ROOT_STATE, shownForEditor: false };
  if (isVisited) return { visible: true, state: { isExcluded: false, leadsToException: true }, shownForEditor: false };
  const state = { isExcluded: true, leadsToException: false };
  if (entry.hasEditorInside?.()) return { visible: true, state, shownForEditor: true };
  return { visible: false, state, shownForEditor: false };
}
