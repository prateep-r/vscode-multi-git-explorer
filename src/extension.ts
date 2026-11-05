import * as vscode from 'vscode';
import { registerCommands } from './commands';
import { RepoStore } from './store';
import { RepoDecorationProvider } from './views/decorations';
import { HEAD_SCHEME, HeadContentProvider } from './views/headContent';
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
  const explorer = new RepoExplorerProvider(store, context.workspaceState);
  const reposView = new ReposViewProvider(store);
  const decorations = new RepoDecorationProvider(store);
  const reposTree = vscode.window.createTreeView('multiRepoGit.repos', { treeDataProvider: reposView, showCollapseAll: true });
  reposView.attach(reposTree);
  const explorerTree = vscode.window.createTreeView('multiRepoGit.explorer', { treeDataProvider: explorer, showCollapseAll: true });
  explorer.attach(explorerTree);

  context.subscriptions.push(
    log,
    store,
    explorer,
    reposView,
    reposTree,
    explorerTree,
    decorations,
    vscode.window.registerFileDecorationProvider(decorations),
    vscode.workspace.registerTextDocumentContentProvider(HEAD_SCHEME, new HeadContentProvider()),
    new StatusBar(store),
    ...registerCommands(store, reposView, explorer),
  );

  void store.discover();
  return { store, explorer, reposView, decorations };
}

export function deactivate(): void {}
