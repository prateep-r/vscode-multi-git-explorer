import * as path from 'path';
import * as vscode from 'vscode';
import type { ExplorerNode, RepoExplorerProvider } from './views/repoExplorer';

/**
 * New File and New Folder for the Repo Explorer. Tree views can't edit a
 * name in place like the built-in Explorer, so the name is asked for in an
 * input box. Nested paths such as `src/utils/date.ts` create the folders
 * on the way.
 */
export function registerFileCommands(explorer: RepoExplorerProvider): vscode.Disposable[] {
  const create = async (kind: 'file' | 'folder', target?: ExplorerNode, name?: unknown) => {
    const parent = target ? (target.isDir ? target.uri : vscode.Uri.file(path.dirname(target.uri.fsPath))) : explorer.selectedFolder();
    if (!parent) return;
    const where = vscode.workspace.asRelativePath(parent, true);
    const entered =
      typeof name === 'string'
        ? name
        : await vscode.window.showInputBox({
            title: kind === 'file' ? 'New File' : 'New Folder',
            prompt: `In ${where === parent.fsPath ? path.basename(parent.fsPath) : where}/`,
            placeHolder: kind === 'file' ? 'name.ts, or a path like src/utils/date.ts' : 'name, or a path like src/utils',
            validateInput: value => validate(parent, value),
          });
    if (!entered?.trim()) return;
    const problem = await validate(parent, entered);
    if (problem) {
      void vscode.window.showErrorMessage(problem);
      return;
    }

    const uri = vscode.Uri.file(path.join(parent.fsPath, entered.trim()));
    if (kind === 'folder') {
      await vscode.workspace.fs.createDirectory(uri);
    } else {
      const edit = new vscode.WorkspaceEdit();
      edit.createFile(uri, { ignoreIfExists: false });
      if (!(await vscode.workspace.applyEdit(edit))) {
        void vscode.window.showErrorMessage(`Couldn't create ${entered.trim()}.`);
        return;
      }
      await vscode.window.showTextDocument(uri, { preview: false });
    }
    await explorer.reveal(uri, kind === 'folder');
  };

  return [
    vscode.commands.registerCommand('multiRepoExplorer.newFile', (target?: ExplorerNode, name?: unknown) => create('file', target, name)),
    vscode.commands.registerCommand('multiRepoExplorer.newFolder', (target?: ExplorerNode, name?: unknown) => create('folder', target, name)),
  ];
}

/** An error message for a name the user typed, or undefined when it's fine. */
async function validate(parent: vscode.Uri, value: string): Promise<string | undefined> {
  const name = value.trim();
  if (!name) return undefined;
  if (path.isAbsolute(name)) return 'Enter a name or a relative path.';
  const target = path.resolve(parent.fsPath, name);
  if (!target.startsWith(parent.fsPath + path.sep)) return 'The new item must be inside this folder.';
  if (name.split(/[\\/]/).some(part => part === '' || part === '.' || part === '..')) return 'Remove the empty or "." parts from the path.';
  try {
    await vscode.workspace.fs.stat(vscode.Uri.file(target));
    return `${name} already exists here.`;
  } catch {
    return undefined;
  }
}
