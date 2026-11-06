/**
 * The problem badge of a file, as the built-in Explorer shows it
 * (VS Code 1.145, markersFileDecorations.ts): errors and warnings only, the
 * count as the badge up to `9+`, and the color of the most severe.
 */
export interface ProblemBadge {
  badge: string;
  tooltip: string;
  isError: boolean;
}

export function problemBadge(errors: number, warnings: number): ProblemBadge | undefined {
  const count = errors + warnings;
  if (count === 0) return undefined;
  return {
    badge: count < 10 ? String(count) : '9+',
    tooltip: count === 1 ? '1 problem in this file' : `${count} problems in this file`,
    isError: errors > 0,
  };
}
