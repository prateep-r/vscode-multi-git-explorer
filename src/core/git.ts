import { execFile } from 'child_process';
import { parseStatusV2, type StatusSummary } from './porcelain';

export interface GitOptions {
  gitPath?: string;
  timeoutMs?: number;
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
    execFile(
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
        if (error) {
          const detail = stderr.trim() || error.message;
          reject(new GitError(error.killed ? `git ${args[0]} timed out` : detail.split('\n')[0], stderr));
        } else {
          resolve(stdout);
        }
      },
    );
  });
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
