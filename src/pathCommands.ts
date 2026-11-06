import * as path from 'path';
import * as vscode from 'vscode';
import { runGit } from './core/git';
import { literalGlob, repoRelative } from './core/paths';
import { resolveRemoteTarget, type RemoteTarget } from './core/remoteLink';
import { guessHostKind, parseRemote, webUrl } from './core/remoteUrl';
import type { RepoEntry, RepoStore } from './store';
import type { ExplorerNode } from './views/repoExplorer';
import { folderOf, gitPath, isMultiRoot, onDisk, pickRows } from './workspace';

/**
 * Commands of the built-in Explorer's right-click menu that don't change
 * files: reveal, open, search, copy paths, compare, timeline, and links to
 * the repo's website.
 */
export function registerPathCommands(store: RepoStore, tree: vscode.TreeView<ExplorerNode>): vscode.Disposable[] {
  /**
   * Registers a command on the rows it was invoked on. With `onDiskOnly`,
   * rows of deleted files are left out, since there is no file to act on;
   * keyboard shortcuts can reach them although the menu hides the command.
   */
  const command = (id: string, fn: (nodes: ExplorerNode[]) => unknown, onDiskOnly = true) =>
    vscode.commands.registerCommand(id, (clicked?: ExplorerNode, selected?: ExplorerNode[]) => {
      const picked = pickRows(clicked, selected ?? tree.selection, n => n.uri.fsPath);
      const nodes = onDiskOnly ? picked.filter(onDisk) : picked;
      return nodes.length ? fn(nodes) : undefined;
    });

  let compareWith: vscode.Uri | undefined;
  const updateSelection = () => {
    const twoFiles = tree.selection.length === 2 && tree.selection.every(n => !n.isDir && onDisk(n));
    void vscode.commands.executeCommand('setContext', 'multiRepoExplorer.twoFilesSelected', twoFiles);
  };

  const revealInOS = (nodes: ExplorerNode[]) =>
    Promise.all(nodes.map(n => vscode.commands.executeCommand('revealFileInOS', n.uri)));

  return [
    tree.onDidChangeSelection(updateSelection),

    // One command per title, since the built-in Explorer names this differently on each system.
    command('multiRepoExplorer.revealInFinder', revealInOS),
    command('multiRepoExplorer.revealInFileExplorer', revealInOS),
    command('multiRepoExplorer.openContainingFolder', revealInOS),

    command('multiRepoExplorer.openInTerminal', nodes => {
      for (const dir of new Set(nodes.map(n => folderOf(n).fsPath))) {
        vscode.window.createTerminal({ name: path.basename(dir), cwd: dir }).show();
      }
    }),

    command('multiRepoExplorer.findInFolder', nodes =>
      vscode.commands.executeCommand('workbench.action.findInFiles', {
        filesToInclude: [...new Set(nodes.map(n => searchPath(folderOf(n))))].join(', '),
        triggerSearch: true,
      }),
    ),

    command('multiRepoExplorer.openToSide', async nodes => {
      for (const n of nodes.filter(n => !n.isDir)) {
        await vscode.commands.executeCommand('vscode.open', n.uri, { viewColumn: vscode.ViewColumn.Beside, preview: false });
      }
    }),

    command('multiRepoExplorer.revealInExplorer', nodes => vscode.commands.executeCommand('revealInExplorer', nodes[0].uri)),

    command('multiRepoExplorer.copyPath', nodes => copy(nodes.map(n => n.uri.fsPath), 'path'), false),

    command('multiRepoExplorer.copyRelativePath', nodes => copy(nodes.map(n => relativePath(n.uri)), 'relative path'), false),

    command(
      'multiRepoExplorer.copyRemoteUrl',
      async nodes => {
        const urls = await remoteUrls(store, nodes);
        if (urls.length) await copy(urls, 'link');
      },
      false,
    ),

    command(
      'multiRepoExplorer.openOnRemote',
      async nodes => {
        for (const url of await remoteUrls(store, nodes)) await vscode.env.openExternal(vscode.Uri.parse(url, true));
      },
      false,
    ),

    command('multiRepoExplorer.openTimeline', async nodes => {
      const file = nodes.find(n => !n.isDir);
      if (!file) return;
      // The Timeline view follows the active editor, so open the file first.
      await vscode.commands.executeCommand('vscode.open', file.uri, { preview: true, preserveFocus: true });
      await vscode.commands.executeCommand('files.openTimeline');
    }),

    command('multiRepoExplorer.selectForCompare', nodes => {
      compareWith = nodes[0].uri;
      void vscode.commands.executeCommand('setContext', 'multiRepoExplorer.compareSelected', true);
    }),

    command('multiRepoExplorer.compareWithSelected', nodes => (compareWith ? compare(compareWith, nodes[0].uri) : undefined)),

    command('multiRepoExplorer.compareSelected', nodes => {
      const files = nodes.filter(n => !n.isDir);
      return files.length === 2 ? compare(files[0].uri, files[1].uri) : undefined;
    }),
  ];
}

function compare(left: vscode.Uri, right: vscode.Uri): Thenable<unknown> {
  const title = `${path.basename(left.fsPath)} ↔ ${path.basename(right.fsPath)}`;
  return vscode.commands.executeCommand('vscode.diff', left, right, title);
}

/** Copies lines to the clipboard; `what` is singular and gets an "s" for several. */
async function copy(lines: string[], what: string): Promise<void> {
  await vscode.env.clipboard.writeText(lines.join('\n'));
  vscode.window.setStatusBarMessage(`Copied ${lines.length > 1 ? `${lines.length} ${what}s` : what}`, 2000);
}

/** A path relative to its workspace folder, with the separator `explorer.copyRelativePathSeparator` asks for. */
function relativePath(uri: vscode.Uri): string {
  const rel = vscode.workspace.asRelativePath(uri, isMultiRoot()) || path.basename(uri.fsPath);
  const setting = vscode.workspace.getConfiguration('explorer').get<string>('copyRelativePathSeparator', 'auto');
  const sep = setting === '/' || setting === '\\' ? setting : path.sep;
  return rel.split('/').join(sep);
}

/** A folder in the form the Search view's "files to include" expects, such as `./src/utils`. */
function searchPath(folder: vscode.Uri): string {
  const rel = vscode.workspace.asRelativePath(folder, isMultiRoot());
  if (rel === folder.fsPath) return literalGlob(folder.fsPath);
  return rel ? `./${literalGlob(rel)}` : '.';
}

/** Web links to rows on their repo's site, telling the user when one can't be made. */
async function remoteUrls(store: RepoStore, nodes: readonly ExplorerNode[]): Promise<string[]> {
  const urls: string[] = [];
  const notes = new Set<string>();
  // Several rows of one repo share its remote, so ask git once per repo.
  const targets = new Map<string, Promise<RemoteTarget | undefined>>();
  for (const node of nodes) {
    const repo = store.repoContaining(node.uri.fsPath);
    if (!repo) {
      notes.add(`${path.basename(node.uri.fsPath)} is not in a git repository.`);
      continue;
    }
    if (!targets.has(repo.root)) targets.set(repo.root, remoteTarget(repo));
    const target = await targets.get(repo.root)!;
    const web = target && parseRemote(target.url);
    if (!target || !web) {
      notes.add(`${repo.name} has no remote on a website that a link can be made for.`);
      continue;
    }
    const hosts = vscode.workspace.getConfiguration('multiRepoExplorer').get<Record<string, string>>('remoteHosts', {});
    const relPath = repoRelative(repo.root, node.uri.fsPath);
    urls.push(webUrl(web, guessHostKind(web, hosts), { relPath, isDir: node.isDir, ref: target.ref, isCommit: target.isCommit }));
    if (target.note) notes.add(target.note);
  }
  if (notes.size) void vscode.window.showInformationMessage([...notes].join(' '));
  return urls;
}

function remoteTarget(repo: RepoEntry): Promise<RemoteTarget | undefined> {
  const git = (args: string[]) => runGit(repo.root, args, { gitPath: gitPath() }).then(out => out.trim(), () => '');
  const branch = repo.status?.branch;
  const detached = branch ? branch.detached : !repo.cheap?.branch;
  return resolveRemoteTarget(git, {
    branch: detached ? undefined : (branch?.head ?? repo.cheap?.branch),
    oid: branch?.oid ?? repo.cheap?.detachedOid,
  });
}
