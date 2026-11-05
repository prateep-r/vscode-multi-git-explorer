export interface MentionTarget {
  /** Path as the chat should see it, relative to the workspace. */
  path: string;
  isDir: boolean;
}

/** `@path` mentions for pasting into a chat; folders end with "/" so they read as folders. */
export function formatMentions(targets: readonly MentionTarget[]): string {
  return targets
    .map(({ path, isDir }) => {
      const clean = path.split('\\').join('/').replace(/\/+$/, '');
      return `@${clean}${isDir ? '/' : ''}`;
    })
    .join(' ');
}
