import * as vscode from 'vscode';
import { GitError, runGit } from './core/git';
import { FILTER_LABELS, type ExplorerFilter } from './core/filter';
import { Priority, runPool } from './core/queue';
import type { RepoEntry, RepoStore } from './store';
import { GitStatus, type GitAPI, type GitChange, type GitExtension, type GitRepository } from './typings/git';
import type { ExplorerNode, RepoExplorerProvider } from './views/repoExplorer';
import type { ReposNode, ReposViewProvider } from './views/reposView';

const NETWORK_TIMEOUT_MS = 120_000;

type CommandArg = vscode.Uri | ExplorerNode | ReposNode | undefined;

export function registerCommands(
  store: RepoStore,
  reposView: ReposViewProvider,
  explorer: RepoExplorerProvider,
): vscode.Disposable[] {
  /** Finds the repo a command was invoked on: a view row, an Explorer folder, or the active file. */
  const repoFrom = (arg: CommandArg): RepoEntry | undefined => {
    let fsPath: string | undefined;
    if (arg instanceof vscode.Uri) fsPath = arg.fsPath;
    else if (arg && 'uri' in arg) fsPath = arg.uri.fsPath;
    else if (arg && arg.type === 'repo') fsPath = arg.root;
    const repo = fsPath ? (store.get(fsPath) ?? store.repoContaining(fsPath)) : store.activeRepo();
    if (!repo) void vscode.window.showWarningMessage('Multi-Repo Git Status: this folder is not a git repository.');
    return repo;
  };

  const withRepo = (fn: (repo: RepoEntry) => unknown) => (arg: CommandArg) => {
    const repo = repoFrom(arg);
    return repo ? fn(repo) : undefined;
  };

  const git = (repo: RepoEntry, args: string[], timeoutMs?: number) => runGit(repo.root, args, { gitPath: gitPath(), timeoutMs });

  /** Runs a git command with a progress notification, then re-checks the repo. */
  const runWithProgress = async (repo: RepoEntry, title: string, args: string[]) => {
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `${title} ${repo.name}…` },
        () => git(repo, args, NETWORK_TIMEOUT_MS),
      );
    } catch (error) {
      showGitError(`${title} ${repo.name} failed`, error);
    } finally {
      store.refresh(repo.root, Priority.User);
    }
  };

  return [
    vscode.commands.registerCommand('multiRepoGit.refresh', async () => {
      await store.discover();
      store.refreshAll(Priority.User);
    }),

    vscode.commands.registerCommand('multiRepoGit.fetchAll', () => fetchAll(store)),

    vscode.commands.registerCommand('multiRepoGit.filter', async () => {
      const text = await vscode.window.showInputBox({
        title: 'Filter repos',
        prompt: 'Show repos whose path or branch contains this text',
        value: reposView.filter,
        placeHolder: 'auth',
      });
      if (text !== undefined) reposView.setFilter(text);
    }),

    vscode.commands.registerCommand('multiRepoGit.clearFilter', () => reposView.setFilter('')),

    ...['multiRepoGit.filterExplorer', 'multiRepoGit.filterExplorerActive'].map(id =>
      vscode.commands.registerCommand(id, () => pickExplorerFilters(explorer)),
    ),

    vscode.commands.registerCommand('multiRepoGit.clearExplorerFilter', () => explorer.setFilters([])),

    vscode.commands.registerCommand(
      'multiRepoGit.openInScm',
      withRepo(async repo => {
        // Make sure VS Code's Git knows this repo, then show the Source Control view.
        // VS Code has no public API to select one repo in that view, so it may
        // still show other repos above this one.
        await openInGitExtension(repo);
        await vscode.commands.executeCommand('workbench.view.scm');
      }),
    ),

    vscode.commands.registerCommand(
      'multiRepoGit.openChanges',
      withRepo(async repo => {
        const gitRepo = await openInGitExtension(repo);
        const api = await gitApi();
        if (!gitRepo || !api) {
          void vscode.window.showWarningMessage(`Multi-Repo Git Status: couldn't open ${repo.name} in VS Code's Git.`);
          return;
        }
        await gitRepo.status();
        const changes = uniqueChanges([
          ...gitRepo.state.mergeChanges,
          ...gitRepo.state.indexChanges,
          ...gitRepo.state.workingTreeChanges,
          ...(gitRepo.state.untrackedChanges ?? []),
        ]);
        if (changes.length === 0) {
          void vscode.window.showInformationMessage(`${repo.name} has no changes.`);
          return;
        }
        const resources = changes.map(change => {
          const added = [GitStatus.INDEX_ADDED, GitStatus.UNTRACKED, GitStatus.INTENT_TO_ADD].includes(change.status);
          const deleted = [GitStatus.DELETED, GitStatus.INDEX_DELETED].includes(change.status);
          return [
            change.uri,
            added ? undefined : api.toGitUri(change.originalUri, 'HEAD'),
            deleted ? undefined : change.uri,
          ];
        });
        await vscode.commands.executeCommand('vscode.changes', `Changes: ${repo.name}`, resources);
      }),
    ),

    vscode.commands.registerCommand(
      'multiRepoGit.switchBranch',
      withRepo(async repo => {
        let refs: string;
        try {
          refs = await git(repo, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes']);
        } catch (error) {
          showGitError(`Couldn't list branches of ${repo.name}`, error);
          return;
        }
        const current = repo.view.branchLabel;
        const local = new Set<string>();
        const items: (vscode.QuickPickItem & { branch: string })[] = [];
        for (const ref of refs.split('\n').filter(Boolean)) {
          if (ref.startsWith('refs/heads/')) {
            const branch = ref.slice('refs/heads/'.length);
            local.add(branch);
            items.push({ label: `$(git-branch) ${branch}`, description: branch === current ? 'current' : undefined, branch });
          }
        }
        for (const ref of refs.split('\n').filter(Boolean)) {
          if (!ref.startsWith('refs/remotes/') || ref.endsWith('/HEAD')) continue;
          const remoteBranch = ref.slice('refs/remotes/'.length);
          const branch = remoteBranch.slice(remoteBranch.indexOf('/') + 1);
          if (!local.has(branch)) items.push({ label: `$(cloud) ${remoteBranch}`, description: 'remote', branch });
        }
        const picked = await vscode.window.showQuickPick(items, {
          title: `Switch branch in ${repo.name}`,
          placeHolder: `Current: ${current}`,
          matchOnDescription: true,
        });
        if (!picked || picked.branch === current) return;
        try {
          await git(repo, ['switch', picked.branch]);
        } catch (error) {
          showGitError(`Couldn't switch ${repo.name} to ${picked.branch}`, error);
        } finally {
          store.refresh(repo.root, Priority.User);
        }
      }),
    ),

    vscode.commands.registerCommand('multiRepoGit.fetch', withRepo(repo => runWithProgress(repo, 'Fetching', ['fetch']))),

    vscode.commands.registerCommand('multiRepoGit.pull', withRepo(repo => runWithProgress(repo, 'Pulling', ['pull']))),

    vscode.commands.registerCommand(
      'multiRepoGit.push',
      withRepo(async repo => {
        if (repo.status && !repo.status.branch.upstream && !repo.status.branch.detached) {
          const remotes = (await git(repo, ['remote']).catch(() => '')).split('\n').filter(Boolean);
          const remote = remotes.includes('origin') ? 'origin' : remotes[0];
          if (!remote) {
            void vscode.window.showWarningMessage(`${repo.name} has no remote to push to.`);
            return;
          }
          return runWithProgress(repo, 'Pushing', ['push', '--set-upstream', remote, 'HEAD']);
        }
        return runWithProgress(repo, 'Pushing', ['push']);
      }),
    ),

    vscode.commands.registerCommand(
      'multiRepoGit.openTerminal',
      withRepo(repo => vscode.window.createTerminal({ name: repo.name, cwd: repo.root }).show()),
    ),

    vscode.commands.registerCommand(
      'multiRepoGit.openInNewWindow',
      withRepo(repo => vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(repo.root), { forceNewWindow: true })),
    ),

    vscode.commands.registerCommand(
      'multiRepoGit.copyBranch',
      withRepo(async repo => {
        await vscode.env.clipboard.writeText(repo.view.branchLabel.replace(/ \(detached\)$/, ''));
        vscode.window.setStatusBarMessage(`Copied "${repo.view.branchLabel}"`, 2000);
      }),
    ),

    vscode.commands.registerCommand('multiRepoGit.scanFolder', (arg: CommandArg) => {
      const uri = arg instanceof vscode.Uri ? arg : arg && 'uri' in arg ? arg.uri : undefined;
      if (uri) return store.scanFolder(uri.fsPath);
      return undefined;
    }),
  ];
}

const FILTER_DETAILS: Record<ExplorerFilter, [string, string]> = {
  changes: ['$(diff)', 'Repos with uncommitted or conflicted files, showing only those files'],
  unpushed: ['$(arrow-up)', 'Repos with commits that are not pushed yet'],
  behind: ['$(arrow-down)', 'Repos with new commits on the remote (as of the last fetch)'],
};

async function pickExplorerFilters(explorer: RepoExplorerProvider): Promise<void> {
  const active = new Set(explorer.activeFilters);
  const items = (Object.keys(FILTER_DETAILS) as ExplorerFilter[]).map(filter => ({
    label: `${FILTER_DETAILS[filter][0]} ${FILTER_LABELS[filter]}`,
    detail: FILTER_DETAILS[filter][1],
    picked: active.size === 0 ? filter === 'changes' : active.has(filter),
    filter,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Show in Repo Explorer',
    placeHolder: 'Pick what to show. Pick nothing to show everything.',
    canPickMany: true,
  });
  if (picked) explorer.setFilters(picked.map(item => item.filter));
}

async function fetchAll(store: RepoStore): Promise<void> {
  const repos = store.all().filter(r => r.cheap?.hasRemote);
  if (repos.length === 0) {
    void vscode.window.showInformationMessage('Multi-Repo Git Status: no repos with a remote to fetch.');
    return;
  }
  const concurrency = vscode.workspace.getConfiguration('multiRepoGit').get('maxConcurrency', 6);
  const failed: string[] = [];
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Fetching repos', cancellable: true },
    async (progress, token) => {
      let done = 0;
      await runPool(repos, concurrency, async repo => {
        if (token.isCancellationRequested) return;
        try {
          await runGit(repo.root, ['fetch'], { gitPath: gitPath(), timeoutMs: NETWORK_TIMEOUT_MS });
        } catch {
          failed.push(repo.name);
        }
        store.refresh(repo.root, Priority.Background);
        done++;
        progress.report({ message: `${done} of ${repos.length}`, increment: 100 / repos.length });
      });
    },
  );
  if (failed.length) {
    const shown = failed.slice(0, 5).join(', ') + (failed.length > 5 ? `, and ${failed.length - 5} more` : '');
    void vscode.window.showWarningMessage(`Couldn't fetch ${failed.length} ${failed.length === 1 ? 'repo' : 'repos'}: ${shown}`);
  }
}

async function gitApi(): Promise<GitAPI | undefined> {
  const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!extension) return undefined;
  const exports = extension.isActive ? extension.exports : await extension.activate();
  return exports?.getAPI(1);
}

async function openInGitExtension(repo: RepoEntry): Promise<GitRepository | undefined> {
  const api = await gitApi();
  if (!api) return undefined;
  const uri = vscode.Uri.file(repo.root);
  return (api.getRepository(uri) ?? (await api.openRepository(uri))) || undefined;
}

function uniqueChanges(changes: GitChange[]): GitChange[] {
  const seen = new Map<string, GitChange>();
  for (const change of changes) if (!seen.has(change.uri.toString())) seen.set(change.uri.toString(), change);
  return [...seen.values()];
}

function gitPath(): string | undefined {
  const value = vscode.workspace.getConfiguration('git').get<string | string[]>('path');
  return (Array.isArray(value) ? value[0] : value) || undefined;
}

function showGitError(title: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const detail = error instanceof GitError ? error.stderr.trim() : undefined;
  void vscode.window.showErrorMessage(`${title}: ${message}`, ...(detail ? ['Show Details'] : [])).then(choice => {
    if (choice) void vscode.window.showErrorMessage(detail!, { modal: true });
  });
}
