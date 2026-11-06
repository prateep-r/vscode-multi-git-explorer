import * as vscode from 'vscode';
import { registerChatTargets } from './chatTargets';
import { registerCommands } from './commands';
import { registerFileCommands } from './fileCommands';
import { RepoStore } from './store';
import { RepoDecorationProvider } from './views/decorations';
import { HEAD_SCHEME, HeadContentProvider } from './views/headContent';
import { RepoExplorerProvider } from './views/repoExplorer';
import { ReposViewProvider } from './views/reposView';
import { StatusBar } from './views/statusBar';

/** Returned from `activate` so integration tests can look inside. */
export interface MultiRepoExplorerApi {
  store: RepoStore;
  explorer: RepoExplorerProvider;
  reposView: ReposViewProvider;
  decorations: RepoDecorationProvider;
}

export function activate(context: vscode.ExtensionContext): MultiRepoExplorerApi {
  const log = vscode.window.createOutputChannel('Multi-Repo Explorer');
  const store = new RepoStore(log);
  const explorer = new RepoExplorerProvider(store, context.workspaceState);
  const reposView = new ReposViewProvider(store);
  const decorations = new RepoDecorationProvider(store);
  const reposTree = vscode.window.createTreeView('multiRepoExplorer.repos', { treeDataProvider: reposView, showCollapseAll: true, canSelectMany: true });
  reposView.attach(reposTree);
  const explorerTree = vscode.window.createTreeView('multiRepoExplorer.explorer', {
    treeDataProvider: explorer,
    showCollapseAll: true,
    canSelectMany: true,
  });
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
    ...registerChatTargets(),
    ...registerFileCommands(explorer),
  );

  void store.discover();
  void showOnStartup();
  return { store, explorer, reposView, decorations };
}

/**
 * VS Code reopens the side bar on the built-in Explorer, so switch it to the Repo Explorer
 * when a folder is open. Keyboard focus goes back to the editor, if one was focused.
 */
async function showOnStartup(): Promise<void> {
  if (!vscode.workspace.workspaceFolders?.length) return;
  if (!vscode.workspace.getConfiguration('multiRepoExplorer').get('showOnStartup', true)) return;
  const hadEditor = vscode.window.activeTextEditor !== undefined;
  await vscode.commands.executeCommand('workbench.view.extension.multiRepoExplorer');
  if (hadEditor) await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
}

export function deactivate(): void {}
