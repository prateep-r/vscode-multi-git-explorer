import * as path from 'path';
import * as vscode from 'vscode';
import { isValidBranchName, listBranches, stashChanges, switchBranch, type Branches } from './core/branches';
import { GitError, runGit } from './core/git';
import { FILTER_LABELS, type ExplorerFilter } from './core/filter';
import { Priority, runPool } from './core/queue';
import type { RepoEntry, RepoStore } from './store';
import { GitStatus, type GitAPI, type GitChange, type GitExtension, type GitRepository } from './typings/git';
import { headUri } from './views/headContent';
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
    if (!repo) void vscode.window.showWarningMessage('Multi-Repo Explorer: this folder is not a git repository.');
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
    vscode.commands.registerCommand('multiRepoExplorer.refresh', async () => {
      await store.discover();
      store.refreshAll(Priority.User);
    }),

    vscode.commands.registerCommand('multiRepoExplorer.fetchAll', () => fetchAll(store)),

    vscode.commands.registerCommand('multiRepoExplorer.filter', async () => {
      const text = await vscode.window.showInputBox({
        title: 'Filter repos',
        prompt: 'Show repos whose path or branch contains this text',
        value: reposView.filter,
        placeHolder: 'auth',
      });
      if (text !== undefined) reposView.setFilter(text);
    }),

    vscode.commands.registerCommand('multiRepoExplorer.clearFilter', () => reposView.setFilter('')),

    vscode.commands.registerCommand('multiRepoExplorer.filterExplorer', () => pickExplorerFilters(explorer)),

    // Each filter has an "off" and an "on" command so the title-bar button can show its state.
    ...(['changes', 'unpushed', 'behind'] as const).flatMap(filter =>
      [FILTER_COMMANDS[filter], `${FILTER_COMMANDS[filter]}On`].map(id =>
        vscode.commands.registerCommand(id, () => explorer.toggleFilter(filter)),
      ),
    ),

    vscode.commands.registerCommand('multiRepoExplorer.clearExplorerFilter', () => explorer.setFilters([])),

    vscode.commands.registerCommand('multiRepoExplorer.openChange', (node: ExplorerNode) => openChange(store, node)),

    vscode.commands.registerCommand('multiRepoExplorer.openChangedFile', (node: ExplorerNode) =>
      vscode.commands.executeCommand('vscode.open', node.uri),
    ),

    vscode.commands.registerCommand(
      'multiRepoExplorer.openInScm',
      withRepo(async repo => {
        // Make sure VS Code's Git knows this repo, then show the Source Control view.
        // VS Code has no public API to select one repo in that view, so it may
        // still show other repos above this one.
        await openInGitExtension(repo);
        await vscode.commands.executeCommand('workbench.view.scm');
      }),
    ),

    vscode.commands.registerCommand(
      'multiRepoExplorer.openChanges',
      withRepo(async repo => {
        const gitRepo = await openInGitExtension(repo);
        const api = await gitApi();
        if (!gitRepo || !api) {
          void vscode.window.showWarningMessage(`Multi-Repo Explorer: couldn't open ${repo.name} in VS Code's Git.`);
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
      'multiRepoExplorer.switchBranch',
      withRepo(repo => pickAndSwitchBranch(store, repo)),
    ),

    vscode.commands.registerCommand('multiRepoExplorer.fetch', withRepo(repo => runWithProgress(repo, 'Fetching', ['fetch']))),

    vscode.commands.registerCommand('multiRepoExplorer.pull', withRepo(repo => runWithProgress(repo, 'Pulling', ['pull']))),

    vscode.commands.registerCommand(
      'multiRepoExplorer.push',
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
      'multiRepoExplorer.openTerminal',
      withRepo(repo => vscode.window.createTerminal({ name: repo.name, cwd: repo.root }).show()),
    ),

    vscode.commands.registerCommand(
      'multiRepoExplorer.openInNewWindow',
      withRepo(repo => vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(repo.root), { forceNewWindow: true })),
    ),

    vscode.commands.registerCommand(
      'multiRepoExplorer.copyBranch',
      withRepo(async repo => {
        await vscode.env.clipboard.writeText(repo.view.branchLabel.replace(/ \(detached\)$/, ''));
        vscode.window.setStatusBarMessage(`Copied "${repo.view.branchLabel}"`, 2000);
      }),
    ),

    vscode.commands.registerCommand('multiRepoExplorer.scanFolder', (arg: CommandArg) => {
      const uri = arg instanceof vscode.Uri ? arg : arg && 'uri' in arg ? arg.uri : undefined;
      if (uri) return store.scanFolder(uri.fsPath);
      return undefined;
    }),
  ];
}

const FILTER_COMMANDS: Record<ExplorerFilter, string> = {
  changes: 'multiRepoExplorer.filterChanges',
  unpushed: 'multiRepoExplorer.filterUnpushed',
  behind: 'multiRepoExplorer.filterBehind',
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
    title: 'Show in Repo Explorer',
    placeHolder: 'Pick what to show. Pick nothing to show everything.',
    canPickMany: true,
  });
  if (picked) explorer.setFilters(picked.map(item => item.filter));
}

const DIFF_LABELS: Record<string, string> = {
  M: 'Working Tree',
  R: 'Renamed',
  A: 'Added',
  U: 'Untracked',
  D: 'Deleted',
};

/** Shows a changed file as a diff against HEAD; conflicted files open as-is so they can be resolved. */
async function openChange(store: RepoStore, node: ExplorerNode): Promise<void> {
  const repo = store.repoContaining(node.uri.fsPath);
  const change = node.change;
  if (!repo || !change || change.letter === '!') {
    await vscode.commands.executeCommand('vscode.open', node.uri);
    return;
  }
  const relPath = path.relative(repo.root, node.uri.fsPath).split(path.sep).join('/');
  // A file inside an untracked folder carries the folder's change, so it's new too.
  const isNew = change.letter === 'A' || change.letter === 'U';
  const left = headUri(node.uri, repo.root, isNew ? undefined : (change.origPath ?? relPath));
  const right = change.letter === 'D' ? headUri(node.uri, repo.root, undefined) : node.uri;
  const title = `${path.basename(node.uri.fsPath)} (${DIFF_LABELS[change.letter]})`;
  await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
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

  const current = repo.status?.branch.detached ? undefined : (repo.status?.branch.head ?? repo.cheap?.branch);
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
  const repos = store.all().filter(r => r.cheap?.hasRemote);
  if (repos.length === 0) {
    void vscode.window.showInformationMessage('Multi-Repo Explorer: no repos with a remote to fetch.');
    return;
  }
  const concurrency = vscode.workspace.getConfiguration('multiRepoExplorer').get('maxConcurrency', 6);
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
