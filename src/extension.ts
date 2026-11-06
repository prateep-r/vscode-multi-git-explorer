import * as vscode from 'vscode';
import { registerChatTargets } from './chatTargets';
import { registerCommands } from './commands';
import { FileOperations, registerFileCommands } from './fileCommands';
import { registerPathCommands } from './pathCommands';
import { copyOldSettings, offerToUninstallOld } from './rename';
import { RepoStore } from './store';
import { RepoDecorationProvider } from './views/decorations';
import { HEAD_SCHEME, HeadContentProvider } from './views/headContent';
import { RepoExplorerProvider } from './views/repoExplorer';
import { ReposViewProvider } from './views/reposView';
import { StatusBar } from './views/statusBar';

/** Returned from `activate` so integration tests can look inside. */
export interface MultiGitExplorerApi {
  store: RepoStore;
  explorer: RepoExplorerProvider;
  reposView: ReposViewProvider;
  decorations: RepoDecorationProvider;
  files: FileOperations;
}

export function activate(context: vscode.ExtensionContext): MultiGitExplorerApi {
  const log = vscode.window.createOutputChannel('Multi-Git Explorer');
  const store = new RepoStore(log);
  const explorer = new RepoExplorerProvider(store, context.workspaceState);
  const reposView = new ReposViewProvider(store);
  const decorations = new RepoDecorationProvider(store);
  const reposTree = vscode.window.createTreeView('multiGitExplorer.repos', { treeDataProvider: reposView, showCollapseAll: true, canSelectMany: true });
  reposView.attach(reposTree);
  const files = new FileOperations(store, explorer);
  const explorerTree = vscode.window.createTreeView('multiGitExplorer.explorer', {
    treeDataProvider: explorer,
    showCollapseAll: true,
    canSelectMany: true,
    dragAndDropController: files.dragAndDrop,
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
    ...registerChatTargets(explorerTree),
    files,
    ...registerFileCommands(files, explorer, explorerTree),
    ...registerPathCommands(store, explorer, explorerTree),
  );

  // Settings like scanDepth must be carried over before the first scan reads them.
  void copyOldSettings(context, log).then(() => store.discover());
  void offerToUninstallOld();
  void showOnStartup();
  return { store, explorer, reposView, decorations, files };
}

/**
 * VS Code reopens the side bar on the built-in Explorer, so switch it to the Repo Explorer
 * when a folder is open. Keyboard focus goes back to the editor, if one was focused.
 */
async function showOnStartup(): Promise<void> {
  if (!vscode.workspace.workspaceFolders?.length) return;
  if (!vscode.workspace.getConfiguration('multiGitExplorer').get('showOnStartup', true)) return;
  const hadEditor = vscode.window.activeTextEditor !== undefined;
  await vscode.commands.executeCommand('workbench.view.extension.multiGitExplorer');
  if (hadEditor) await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
}

export function deactivate(): void {}
