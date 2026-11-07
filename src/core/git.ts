import { execFile } from 'child_process';
import { parseStatusV2, type StatusSummary } from './porcelain';

export interface GitOptions {
  gitPath?: string;
  timeoutMs?: number;
  /** Written to git's standard input. */
  input?: string;
  /** Exit codes besides 0 that aren't errors, such as 1 from `check-ignore` when nothing is ignored. */
  okExitCodes?: number[];
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

const GIT_ENV = {
  // Never take index.lock: our status checks must not get in the way of the user's own git commands.
  GIT_OPTIONAL_LOCKS: '0',
  // Fail instead of waiting forever for a password nobody can type.
  GIT_TERMINAL_PROMPT: '0',
};

export function runGit(cwd: string, args: string[], options: GitOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      options.gitPath || 'git',
      args,
      {
        cwd,
        env: { ...process.env, ...GIT_ENV },
        timeout: options.timeoutMs ?? 15_000,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code === 'number' && options.okExitCodes?.includes(error.code)) {
          resolve(stdout);
        } else if (error) {
          const detail = stderr.trim() || error.message;
          reject(new GitError(error.killed ? `git ${args[0]} timed out` : detail.split('\n')[0], stderr));
        } else {
          resolve(stdout);
        }
      },
    );
    // git may exit before reading its input, and writing to it then fails
    // with EPIPE. Its exit code and output still say how it went.
    child.stdin?.on('error', () => {});
    child.stdin?.end(options.input ?? '');
  });
}

/**
 * Which of the paths `.gitignore` and the other exclude files ignore, asked
 * the way VS Code's git extension asks (`check-ignore -v -z --stdin`), so
 * paths re-included with `!` don't count. Paths are absolute, and are
 * returned as given.
 */
export async function checkIgnore(root: string, paths: readonly string[], options: GitOptions = {}): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  const output = await runGit(root, ['check-ignore', '-v', '-z', '--stdin'], { ...options, input: paths.join('\0'), okExitCodes: [1] });
  return parseCheckIgnore(output);
}

/** Parses `check-ignore -v -z` output: source, line, pattern and path per match. */
export function parseCheckIgnore(raw: string): Set<string> {
  const ignored = new Set<string>();
  const elements = raw.split('\0');
  for (let i = 0; i + 3 < elements.length; i += 4) {
    const pattern = elements[i + 2];
    if (pattern && !pattern.startsWith('!')) ignored.add(elements[i + 3]);
  }
  return ignored;
}

export async function readStatus(root: string, countUntracked: boolean, options?: GitOptions): Promise<StatusSummary> {
  const output = await runGit(
    root,
    [
      'status',
      '--porcelain=v2',
      '-z',
      '--branch',
      '--show-stash',
      countUntracked ? '--untracked-files=normal' : '--untracked-files=no',
    ],
    options,
  );
  return parseStatusV2(output);
}
