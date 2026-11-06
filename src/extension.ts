import * as vscode from 'vscode';
import { registerChatTargets } from './chatTargets';
import { registerCommands } from './commands';
import { FileOperations, registerFileCommands } from './fileCommands';
import { registerPathCommands } from './pathCommands';
import { copyOldSettings, offerToUninstallOld } from './rename';
import { RepoStore } from './store';
import { AutoReveal } from './views/autoReveal';
import { CutDecorationProvider } from './views/cutDecorations';
import { RepoDecorationProvider } from './views/decorations';
import { HEAD_SCHEME, HeadContentProvider } from './views/headContent';
import { ProblemDecorationProvider } from './views/problemDecorations';
import { RepoExplorerProvider } from './views/repoExplorer';
import { ReposViewProvider } from './views/reposView';
import { StatusBar } from './views/statusBar';

/** Returned from `activate` so integration tests can look inside. */
export interface MultiGitExplorerApi {
  store: RepoStore;
  explorer: RepoExplorerProvider;
  reposView: ReposViewProvider;
  decorations: RepoDecorationProvider;
  problems: ProblemDecorationProvider;
  cut: CutDecorationProvider;
  autoReveal: AutoReveal;
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
  const problems = new ProblemDecorationProvider();
  const cut = new CutDecorationProvider(files);
  const explorerTree = vscode.window.createTreeView('multiGitExplorer.explorer', {
    treeDataProvider: explorer,
    showCollapseAll: true,
    canSelectMany: true,
    dragAndDropController: files.dragAndDrop,
  });
  explorer.attach(explorerTree);
  const autoReveal = new AutoReveal(explorer, explorerTree);

  context.subscriptions.push(
    log,
    store,
    explorer,
    reposView,
    reposTree,
    explorerTree,
    autoReveal,
    decorations,
    vscode.window.registerFileDecorationProvider(decorations),
    // The provider registered last wins when colors clash: problems over git states, and cut over all.
    problems,
    vscode.window.registerFileDecorationProvider(problems),
    vscode.window.registerFileDecorationProvider(cut),
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
  return { store, explorer, reposView, decorations, problems, cut, autoReveal, files };
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
