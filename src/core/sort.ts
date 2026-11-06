import {
  compareFileExtensionsDefault,
  compareFileExtensionsLower,
  compareFileExtensionsUnicode,
  compareFileExtensionsUpper,
  compareFileNamesDefault,
  compareFileNamesLower,
  compareFileNamesUnicode,
  compareFileNamesUpper,
} from './vs/comparers';

export type SortOrder = 'default' | 'mixed' | 'filesFirst' | 'type' | 'modified' | 'foldersNestsFiles';
export type LexicographicOptions = 'default' | 'upper' | 'lower' | 'unicode';

/** `explorer.sortOrder`, `explorer.sortOrderLexicographicOptions` and `explorer.sortOrderReverse`. */
export interface SortConfig {
  order: SortOrder;
  lexicographic: LexicographicOptions;
  reverse: boolean;
}

export interface Sortable {
  name: string;
  isDir: boolean;
  /** Last modified time, needed for the `modified` order. */
  mtime?: number;
  /** Whether other files are nested under this one (`explorer.fileNesting`). */
  hasNests?: boolean;
}

const ORDERS: readonly SortOrder[] = ['default', 'mixed', 'filesFirst', 'type', 'modified', 'foldersNestsFiles'];
const LEXICOGRAPHIC: readonly LexicographicOptions[] = ['default', 'upper', 'lower', 'unicode'];

export function readSortConfig(order: unknown, lexicographic: unknown, reverse: unknown): SortConfig {
  return {
    order: ORDERS.includes(order as SortOrder) ? (order as SortOrder) : 'default',
    lexicographic: LEXICOGRAPHIC.includes(lexicographic as LexicographicOptions) ? (lexicographic as LexicographicOptions) : 'default',
    reverse: reverse === true,
  };
}

/**
 * Compares two entries of one folder like the built-in Explorer's `FileSorter`
 * (VS Code 1.145). Workspace folders aren't sorted; they keep their order.
 */
export function compareEntries(config: SortConfig): (a: Sortable, b: Sortable) => number {
  const [compareNames, compareExtensions] = {
    upper: [compareFileNamesUpper, compareFileExtensionsUpper],
    lower: [compareFileNamesLower, compareFileExtensionsLower],
    unicode: [compareFileNamesUnicode, compareFileExtensionsUnicode],
    default: [compareFileNamesDefault, compareFileExtensionsDefault],
  }[config.lexicographic];

  return (statA, statB) => {
    // Reversing swaps the two before anything else, so folders also go last.
    if (config.reverse) [statA, statB] = [statB, statA];

    switch (config.order) {
      case 'type':
        if (statA.isDir && !statB.isDir) return -1;
        if (statB.isDir && !statA.isDir) return 1;
        if (statA.isDir && statB.isDir) return compareNames(statA.name, statB.name);
        break;
      case 'filesFirst':
        if (statA.isDir && !statB.isDir) return 1;
        if (statB.isDir && !statA.isDir) return -1;
        break;
      case 'foldersNestsFiles':
        if (statA.isDir && !statB.isDir) return -1;
        if (statB.isDir && !statA.isDir) return 1;
        if (statA.hasNests && !statB.hasNests) return -1;
        if (statB.hasNests && !statA.hasNests) return 1;
        break;
      case 'mixed':
        break;
      default: // 'default', 'modified'
        if (statA.isDir && !statB.isDir) return -1;
        if (statB.isDir && !statA.isDir) return 1;
        break;
    }

    switch (config.order) {
      case 'type':
        return compareExtensions(statA.name, statB.name);
      case 'modified':
        if (statA.mtime !== statB.mtime) return statA.mtime && statB.mtime && statA.mtime < statB.mtime ? 1 : -1;
        return compareNames(statA.name, statB.name);
      default:
        return compareNames(statA.name, statB.name);
    }
  };
}
