/**
 * The chain of folders a row shows with `explorer.compactFolders`, starting
 * at `head`: as long as a folder holds exactly one entry and that entry is a
 * folder, the two are shown as one row, such as `src/main/java`. Like the
 * built-in Explorer, hidden entries such as `.git` or `.DS_Store` count, so a
 * repo's folder never takes in the folder below it.
 *
 * `onlyChildFolder` gives the single child folder of a folder, if that's all
 * it holds.
 */
export async function compactChain(
  head: string,
  onlyChildFolder: (dir: string) => Promise<string | undefined>,
  maxLength = 64,
): Promise<string[]> {
  const chain = [head];
  while (chain.length < maxLength) {
    const child = await onlyChildFolder(chain[chain.length - 1]);
    if (!child) break;
    chain.push(child);
  }
  return chain;
}
