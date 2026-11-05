import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { RepoStore } from './store';
import { RepoDecorationProvider } from './views/decorations';
import { RepoExplorerProvider } from './views/repoExplorer';
import { ReposViewProvider } from './views/reposView';
import { StatusBar } from './views/statusBar';

/** Returned from `activate` so integration tests can look inside. */
export interface MultiRepoGitApi {
  store: RepoStore;
  explorer: RepoExplorerProvider;
  reposView: ReposViewProvider;
  decorations: RepoDecorationProvider;
}

export function activate(context: vscode.ExtensionContext): MultiRepoGitApi {
  const log = vscode.window.createOutputChannel('Multi-Repo Git Status');
  const store = new RepoStore(log);
  const explorer = new RepoExplorerProvider(store);
  const reposView = new ReposViewProvider(store);
  const decorations = new RepoDecorationProvider(store);
  const reposTree = vscode.window.createTreeView('multiRepoGit.repos', { treeDataProvider: reposView, showCollapseAll: true });
  reposView.attach(reposTree);

  context.subscriptions.push(
    log,
    store,
    explorer,
    reposView,
    reposTree,
    vscode.window.createTreeView('multiRepoGit.explorer', { treeDataProvider: explorer, showCollapseAll: true }),
    decorations,
    vscode.window.registerFileDecorationProvider(decorations),
    new StatusBar(store),
    ...registerCommands(store, reposView),
  );

  void store.discover();
  return { store, explorer, reposView, decorations };
}

export function deactivate(): void {}
