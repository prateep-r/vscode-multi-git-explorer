import * as vscode from 'vscode';
import { isValidBranchName, listBranches, stashChanges, switchBranch, type Branches } from './core/branches';
import { classifyError, countRepos, nameList, reposFor, summarize, type BulkAction, type BulkOutcome } from './core/bulk';
import { GitError, runGit } from './core/git';
import { FILTER_LABELS, type ExplorerFilter } from './core/filter';
import { defaultRemote } from './core/remoteLink';
import { Priority, runPool } from './core/queue';
import type { RepoEntry, RepoStore } from './store';
import { GitStatus, type GitAPI, type GitChange, type GitExtension, type GitRepository } from './typings/git';
import { openChange } from './views/changeCommand';
import { gitPath } from './workspace';
import type { ExplorerNode, RepoExplorerProvider } from './views/repoExplorer';
import type { ReposNode, ReposViewProvider } from './views/reposView';

const NETWORK_TIMEOUT_MS = 120_000;

type CommandArg = vscode.Uri | ExplorerNode | ReposNode | undefined;
/** The bulk commands are only on folder and group rows. */
type RowArg = ExplorerNode | ReposNode | undefined;

export function registerCommands(
  store: RepoStore,
  reposView: ReposViewProvider,
  explorer: RepoExplorerProvider,
  log: vscode.OutputChannel,
): vscode.Disposable[] {
  /** Finds the repo a command was invoked on: a view row, an Explorer folder, or the active file. */
  const repoFrom = (arg: CommandArg): RepoEntry | undefined => {
    let fsPath: string | undefined;
    if (arg instanceof vscode.Uri) fsPath = arg.fsPath;
    else if (arg && 'uri' in arg) fsPath = arg.uri.fsPath;
    else if (arg && arg.type === 'repo') fsPath = arg.root;
    const repo = fsPath ? (store.get(fsPath) ?? store.repoContaining(fsPath)) : store.activeRepo();
    if (!repo) void vscode.window.showWarningMessage('Multi-Git Explorer: this folder is not a git repository.');
    return repo;
  };

  const withRepo = (fn: (repo: RepoEntry) => unknown) => (arg: CommandArg) => {
    const repo = repoFrom(arg);
    return repo ? fn(repo) : undefined;
  };

  const git = (repo: RepoEntry, args: string[], timeoutMs?: number) => runGit(repo.root, args, { gitPath: gitPath(), timeoutMs });

  /**
   * What to push: a branch with no upstream gets one on the default remote,
   * as Source Control does. Undefined when there's no remote to push to.
   */
  const pushArgs = async (repo: RepoEntry): Promise<string[] | undefined> => {
    if (repo.status && !repo.status.branch.upstream && !repo.status.branch.detached) {
      const remote = defaultRemote((await git(repo, ['remote']).catch(() => '')).split('\n').filter(Boolean));
      return remote ? ['push', '--set-upstream', remote, 'HEAD'] : undefined;
    }
    return ['push'];
  };

  /** The repos a folder row (outside any repo) or a group row stands for. */
  const reposOf = (arg: RowArg): RepoEntry[] => {
    if (arg && 'uri' in arg) return explorer.reposShownUnder(arg.uri.fsPath);
    if (arg?.type === 'group') return reposView.reposInGroup(arg.key);
    return [];
  };

  const BULK_GIT: Record<Exclude<BulkAction, 'refresh'>, (repo: RepoEntry) => Promise<unknown>> = {
    fetch: repo => git(repo, ['fetch'], NETWORK_TIMEOUT_MS),
    // Never a merge commit, a rebase or a stash: only what can't go wrong in a repo nobody is looking at.
    pull: repo => git(repo, ['pull', '--no-rebase', '--no-autostash', '--ff-only'], NETWORK_TIMEOUT_MS),
    push: async repo => {
      const args = await pushArgs(repo);
      if (!args) throw new Error('no remote to push to');
      return git(repo, args, NETWORK_TIMEOUT_MS);
    },
  };

  /** Fetch All, Pull All, Push All and Refresh All on a folder or group row. */
  const runBulk = async (action: BulkAction, arg: RowArg) => {
    const below = reposOf(arg);
    if (action === 'refresh') {
      for (const repo of below) store.refresh(repo.root, Priority.User);
      vscode.window.setStatusBarMessage(`Refreshing ${countRepos(below.length)}`, 3000);
      return;
    }
    // Whether a repo has something to push comes from its status, which a large workspace reads only for repos on screen.
    if (action === 'push') {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Checking repos' }, () => store.checkUnchecked(below));
    }
    const repos = reposFor(action, below);
    if (repos.length === 0) {
      void vscode.window.showInformationMessage(`Multi-Git Explorer: no repos here to ${action}.`);
      return;
    }
    if (action === 'push' && !(await confirmPush(repos))) return;
    const outcomes = await runOnRepos(store, action, BULK_TITLES[action], repos, BULK_GIT[action]);
    const { text, warn } = summarize(action, outcomes, repos.length);
    if (!warn) {
      vscode.window.setStatusBarMessage(`$(check) ${text}`, 5000);
      return;
    }
    const problems = outcomes.filter(o => o.result !== 'done');
    for (const o of problems) log.appendLine(`${BULK_TITLES[action]}: ${o.detail}`);
    void vscode.window.showWarningMessage(text, ...(problems.length ? ['Show Details'] : [])).then(choice => {
      if (choice) log.show(true);
    });
  };

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
    vscode.commands.registerCommand('multiGitExplorer.refresh', async () => {
      await store.discover();
      store.refreshAll(Priority.User);
    }),

    vscode.commands.registerCommand('multiGitExplorer.fetchAll', () => fetchAll(store)),

    vscode.commands.registerCommand('multiGitExplorer.filter', async () => {
      const text = await vscode.window.showInputBox({
        title: 'Filter repos',
        prompt: 'Show repos whose path or branch contains this text',
        value: reposView.filter,
        placeHolder: 'auth',
      });
      if (text !== undefined) reposView.setFilter(text);
    }),

    vscode.commands.registerCommand('multiGitExplorer.clearFilter', () => reposView.setFilter('')),

    vscode.commands.registerCommand('multiGitExplorer.filterExplorer', () => pickExplorerFilters(explorer)),

    // Each filter has an "off" and an "on" command so the title-bar button can show its state.
    ...(['changes', 'unpushed', 'behind'] as const).flatMap(filter =>
      [FILTER_COMMANDS[filter], `${FILTER_COMMANDS[filter]}On`].map(id =>
        vscode.commands.registerCommand(id, () => explorer.toggleFilter(filter)),
      ),
    ),

    vscode.commands.registerCommand('multiGitExplorer.clearExplorerFilter', () => explorer.setFilters([])),

    vscode.commands.registerCommand('multiGitExplorer.openChange', (node: ExplorerNode, options?: vscode.TextDocumentShowOptions) =>
      openChange(store, node, options),
    ),

    vscode.commands.registerCommand('multiGitExplorer.openChangedFile', (node: ExplorerNode) =>
      vscode.commands.executeCommand('vscode.open', node.uri),
    ),

    vscode.commands.registerCommand(
      'multiGitExplorer.openInScm',
      withRepo(async repo => {
        // Make sure VS Code's Git knows this repo, then show the Source Control view.
        // VS Code has no public API to select one repo in that view, so it may
        // still show other repos above this one.
        await openInGitExtension(repo);
        await vscode.commands.executeCommand('workbench.view.scm');
      }),
    ),

    vscode.commands.registerCommand(
      'multiGitExplorer.openChanges',
      withRepo(async repo => {
        const gitRepo = await openInGitExtension(repo);
        const api = await gitApi();
        if (!gitRepo || !api) {
          void vscode.window.showWarningMessage(`Multi-Git Explorer: couldn't open ${repo.name} in VS Code's Git.`);
          return;
        }
        await gitRepo.status();
        const changes = uniqueChanges([
          ...gitRepo.state.mergeChanges,
          ...gitRepo.state.indexChanges,
          ...gitRepo.state.workingTreeChanges,
          ...gitRepo.state.untrackedChanges,
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
      'multiGitExplorer.switchBranch',
      withRepo(repo => pickAndSwitchBranch(store, repo)),
    ),

    vscode.commands.registerCommand('multiGitExplorer.fetch', withRepo(repo => runWithProgress(repo, 'Fetching', ['fetch']))),

    vscode.commands.registerCommand('multiGitExplorer.pull', withRepo(repo => runWithProgress(repo, 'Pulling', ['pull']))),

    vscode.commands.registerCommand(
      'multiGitExplorer.push',
      withRepo(async repo => {
        const args = await pushArgs(repo);
        if (!args) {
          void vscode.window.showWarningMessage(`${repo.name} has no remote to push to.`);
          return;
        }
        return runWithProgress(repo, 'Pushing', args);
      }),
    ),

    vscode.commands.registerCommand(
      'multiGitExplorer.openTerminal',
      withRepo(repo => vscode.window.createTerminal({ name: repo.name, cwd: repo.root }).show()),
    ),

    vscode.commands.registerCommand(
      'multiGitExplorer.openInNewWindow',
      withRepo(repo => vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(repo.root), { forceNewWindow: true })),
    ),

    vscode.commands.registerCommand(
      'multiGitExplorer.copyBranch',
      withRepo(async repo => {
        await vscode.env.clipboard.writeText(repo.view.branchLabel.replace(/ \(detached\)$/, ''));
        vscode.window.setStatusBarMessage(`Copied "${repo.view.branchLabel}"`, 2000);
      }),
    ),

    ...(['fetch', 'pull', 'push', 'refresh'] as const).map(action =>
      vscode.commands.registerCommand(`multiGitExplorer.${action}AllHere`, (arg: RowArg) => runBulk(action, arg)),
    ),

    vscode.commands.registerCommand('multiGitExplorer.scanFolder', (arg: CommandArg) => {
      const uri = arg instanceof vscode.Uri ? arg : arg && 'uri' in arg ? arg.uri : undefined;
      if (uri) return store.scanFolder(uri.fsPath);
      return undefined;
    }),
  ];
}

const FILTER_COMMANDS: Record<ExplorerFilter, string> = {
  changes: 'multiGitExplorer.filterChanges',
  unpushed: 'multiGitExplorer.filterUnpushed',
  behind: 'multiGitExplorer.filterBehind',
};

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
    title: 'Show in Multi-Git Explorer',
    placeHolder: 'Pick what to show. Pick nothing to show everything.',
    canPickMany: true,
  });
  if (picked) explorer.setFilters(picked.map(item => item.filter));
}

type BranchPick = vscode.QuickPickItem & {
  action?: { local: string } | { remote: string } | { create: true; from?: boolean };
};

async function pickAndSwitchBranch(store: RepoStore, repo: RepoEntry): Promise<void> {
  const operation = repo.cheap?.operation;
  if (operation) {
    void vscode.window.showWarningMessage(`Finish or abort the ${operation.kind} in ${repo.name} before switching branches.`);
    return;
  }
  const options = { gitPath: gitPath() };
  let branches: Branches;
  try {
    branches = await listBranches(repo.root, options);
  } catch (error) {
    showGitError(`Couldn't list branches of ${repo.name}`, error);
    return;
  }

  // Asked from git with the branches, so it's right even if the status is a moment old.
  const current = branches.local.find(b => b.current)?.name;
  const separator = (label: string): BranchPick => ({ label, kind: vscode.QuickPickItemKind.Separator });
  const items: BranchPick[] = [
    { label: '$(plus) Create new branch…', action: { create: true } },
    { label: '$(plus) Create new branch from…', action: { create: true, from: true } },
    separator('local branches'),
    ...branches.local.map(b => ({
      label: `${b.name === current ? '$(check)' : '$(git-branch)'} ${b.name}`,
      description: [
        b.name === current && 'current',
        b.ahead && `↑${b.ahead}`,
        b.behind && `↓${b.behind} behind ${b.upstream}`,
        b.gone && 'upstream deleted',
        b.when,
      ]
        .filter(Boolean)
        .join(' · '),
      action: { local: b.name },
    })),
    ...(branches.remote.length ? [separator('remote branches')] : []),
    ...branches.remote.map(b => ({
      label: `$(cloud) ${b.name}`,
      description: `not checked out · ${b.when}`,
      action: { remote: b.name },
    })),
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: `Switch branch in ${vscode.workspace.asRelativePath(repo.root)}`,
    placeHolder: `Pick a branch or type to search · current: ${repo.view.branchLabel}`,
    matchOnDescription: true,
  });
  const action = picked?.action;
  if (!action || ('local' in action && action.local === current)) return;

  let target: Parameters<typeof switchBranch>[1];
  if ('create' in action) {
    let from: string | undefined;
    if (action.from) {
      const base = await vscode.window.showQuickPick(
        [...branches.local.map(b => b.name), ...branches.remote.map(b => b.name)].map(label => ({ label })),
        { title: `Create a branch in ${repo.name} from…`, placeHolder: 'Pick the branch to start from' },
      );
      if (!base) return;
      from = base.label;
    }
    const name = await vscode.window.showInputBox({
      title: `New branch in ${repo.name}${from ? ` from ${from}` : ''}`,
      prompt: 'Branch name',
      placeHolder: 'feat/my-change',
      validateInput: async value =>
        !value.trim()
          ? undefined
          : (await isValidBranchName(repo.root, value.trim(), options))
            ? branches.local.some(b => b.name === value.trim())
              ? 'A branch with this name already exists'
              : undefined
            : 'Not a valid branch name',
    });
    if (!name?.trim()) return;
    target = { create: name.trim(), from };
  } else {
    target = action;
  }

  const label = 'local' in target ? target.local : 'remote' in target ? target.remote : target.create;
  try {
    let result = await switchBranch(repo.root, target, options);
    if (!result.ok && result.blockedByChanges) {
      const choice = await vscode.window.showWarningMessage(
        `Your uncommitted changes in ${repo.name} would be overwritten by switching to ${label}.`,
        { modal: true, detail: 'Stash them to keep them safe, then switch. You can bring them back later with "git stash pop".' },
        'Stash and Switch',
      );
      if (choice !== 'Stash and Switch') return;
      await stashChanges(repo.root, `Before switching to ${label}`, options);
      result = await switchBranch(repo.root, target, options);
      if (result.ok) {
        void vscode.window.showInformationMessage(`Stashed your changes in ${repo.name} and switched to ${label}.`);
        return;
      }
    }
    if (!result.ok) showGitError(`Couldn't switch ${repo.name} to ${label}`, new Error(result.message));
  } catch (error) {
    showGitError(`Couldn't switch ${repo.name} to ${label}`, error);
  } finally {
    store.refresh(repo.root, Priority.User);
  }
}

async function fetchAll(store: RepoStore): Promise<void> {
  const repos = reposFor('fetch', store.all());
  if (repos.length === 0) {
    void vscode.window.showInformationMessage('Multi-Git Explorer: no repos with a remote to fetch.');
    return;
  }
  const outcomes = await runOnRepos(store, 'fetch', 'Fetching repos', repos, repo =>
    runGit(repo.root, ['fetch'], { gitPath: gitPath(), timeoutMs: NETWORK_TIMEOUT_MS }),
  );
  const failed = outcomes.filter(o => o.result === 'failed').map(o => o.name);
  if (failed.length) {
    void vscode.window.showWarningMessage(`Couldn't fetch ${failed.length} ${failed.length === 1 ? 'repo' : 'repos'}: ${nameList(failed)}`);
  }
}

const BULK_TITLES: Record<Exclude<BulkAction, 'refresh'>, string> = {
  fetch: 'Fetching repos',
  pull: 'Pulling repos',
  push: 'Pushing repos',
};

/**
 * Runs `run` in each repo, at most maxConcurrency at once, with a progress
 * notification that can stop the repos not started yet. A failure doesn't
 * stop the others. Each repo is re-checked as it finishes, so its row
 * updates while the rest run.
 */
async function runOnRepos(
  store: RepoStore,
  action: BulkAction,
  title: string,
  repos: readonly RepoEntry[],
  run: (repo: RepoEntry) => Promise<unknown>,
): Promise<BulkOutcome[]> {
  const concurrency = vscode.workspace.getConfiguration('multiGitExplorer').get('maxConcurrency', 6);
  const outcomes: BulkOutcome[] = [];
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (progress, token) => {
    await runPool(repos, concurrency, async repo => {
      if (token.isCancellationRequested) return;
      try {
        await run(repo);
        outcomes.push({ name: repo.name, result: 'done' });
      } catch (error) {
        const { message } = error as Error;
        const stderr = error instanceof GitError ? error.stderr.trim() : '';
        outcomes.push({ name: repo.name, result: classifyError(action, `${message}\n${stderr}`), detail: `${repo.root}: ${stderr || message}` });
      }
      store.refresh(repo.root, Priority.Background);
      progress.report({ message: `${outcomes.length} of ${repos.length}`, increment: 100 / repos.length });
    });
  });
  return outcomes;
}

/** Asks before pushing many repos at once, naming them; the first push of a branch also sets its upstream. */
async function confirmPush(repos: readonly RepoEntry[]): Promise<boolean> {
  const shown = repos.slice(0, 10).map(r => `${r.name}${r.status?.branch.upstream ? '' : ' (first push, sets an upstream)'}`);
  if (repos.length > 10) shown.push(`and ${repos.length - 10} more`);
  const choice = await vscode.window.showWarningMessage(`Push ${countRepos(repos.length)}?`, { modal: true, detail: shown.join('\n') }, 'Push');
  return choice === 'Push';
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

/** Shows what failed; for git's own errors, its full output is a click away. */
function showGitError(title: string, error: unknown): void {
  // Everything that fails here throws an Error: GitError from git, or one made from a result.
  const { message } = error as Error;
  const detail = error instanceof GitError ? error.stderr.trim() : '';
  void vscode.window.showErrorMessage(`${title}: ${message}`, ...(detail ? ['Show Details'] : [])).then(choice => {
    if (choice) void vscode.window.showErrorMessage(detail, { modal: true });
  });
}
