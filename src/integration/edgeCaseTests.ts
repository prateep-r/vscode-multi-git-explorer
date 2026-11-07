// Integration tests of rare paths across the extension, each named for what
// it guards: keyboard shortcuts with nothing selected, folders that can't be
// read, diffs and files from outside the workspace in the active editor, and
// updates that arrive while the file tree is filtered.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { copyOldSettings } from '../rename';
import type { ExplorerNode } from '../views/repoExplorer';
import { toViewUri } from '../views/viewUri';
import { at, stub, test, waitFor, withScratch } from './harness';

/** Records the given VS Code commands instead of running them. */
function intercept(ids: string[]) {
  const ran: unknown[][] = [];
  const execute = vscode.commands.executeCommand;
  const restore = stub(vscode.commands, 'executeCommand', ((id: string, ...args: unknown[]) => {
    if (!ids.includes(id)) return execute(id, ...args);
    ran.push([id, ...args]);
    return Promise.resolve();
  }) as never);
  return { ran, restore };
}

const treeOf = (explorer: unknown) => (explorer as { treeView: vscode.TreeView<ExplorerNode> }).treeView;

export function registerEdgeCaseTests(): void {
  test('commands with no row act on the selection; Reveal in Finder reveals each row', async ({ explorer }) => {
    await vscode.commands.executeCommand('workbench.view.extension.multiGitExplorer');
    await explorer.reveal(vscode.Uri.file(at('docs/README.md')), false);
    const clipboard = await vscode.env.clipboard.readText();
    const info = stub(vscode.window, 'showInformationMessage', (async () => undefined) as never);
    const { ran, restore } = intercept(['revealFileInOS']);
    try {
      await vscode.commands.executeCommand('multiGitExplorer.copyToAiChat');
      assert.equal(await vscode.env.clipboard.readText(), '@docs/README.md', 'the selected row');
      const group = { type: 'group', key: 'clean' };
      const repoRow = { type: 'repo', root: at('services/search') };
      await vscode.commands.executeCommand('multiGitExplorer.copyToAiChat', repoRow, [group, repoRow]);
      assert.equal(await vscode.env.clipboard.readText(), '@services/search/', 'a group row has nothing to copy');
      await vscode.commands.executeCommand('multiGitExplorer.revealInFinder', { uri: vscode.Uri.file(at('docs')), isDir: true }, [
        { uri: vscode.Uri.file(at('docs')), isDir: true },
        { uri: vscode.Uri.file(at('services')), isDir: true },
      ]);
    } finally {
      restore();
      info();
      await vscode.env.clipboard.writeText(clipboard);
    }
    assert.deepEqual(ran.map(r => (r[1] as vscode.Uri).fsPath), [at('docs'), at('services')]);
  });

  test('a drop into a folder that can\'t be listed still copies, and a paste with nothing in the way keeps its name', ({ files }) =>
    withScratch(async (dir, node) => {
      const outside = mkdtempSync(path.join(tmpdir(), 'multi-git-explorer-drop-'));
      writeFileSync(path.join(outside, 'in.txt'), 'in\n');
      chmodSync(path.join(dir, 'sub'), 0o333);
      try {
        const data = new vscode.DataTransfer();
        data.set('text/uri-list', new vscode.DataTransferItem(vscode.Uri.file(path.join(outside, 'in.txt')).toString()));
        await files.dragAndDrop.handleDrop!(node('sub', true), data, new vscode.CancellationTokenSource().token);
      } finally {
        chmodSync(path.join(dir, 'sub'), 0o755);
        rmSync(outside, { recursive: true, force: true });
      }
      // Dropped below the rows, it goes into the last workspace folder.
      const below = new vscode.DataTransfer();
      below.set('application/vnd.code.tree.multigitexplorer.explorer', new vscode.DataTransferItem([node('sub/in.txt')]));
      const moved = stub(files, 'drop', (async (_: unknown, folder: vscode.Uri) => void (target = folder.fsPath)) as never);
      let target = '';
      try {
        await files.dragAndDrop.handleDrop!(undefined, below, new vscode.CancellationTokenSource().token);
      } finally {
        moved();
      }
      assert.equal(target, vscode.workspace.workspaceFolders!.at(-1)!.uri.fsPath);
      const config = vscode.workspace.getConfiguration('explorer');
      await config.update('incrementalNaming', 'disabled', vscode.ConfigurationTarget.Global);
      try {
        await files.setClipboard([node('a.txt')], false);
        await files.paste(vscode.Uri.file(path.join(dir, 'sub')));
      } finally {
        await config.update('incrementalNaming', undefined, vscode.ConfigurationTarget.Global);
      }
      assert.deepEqual([path.join(dir, 'sub', 'in.txt'), path.join(dir, 'sub', 'a.txt')].map(f => existsSync(f)), [true, true]);
    }));

  test('settings are copied even without a configuration section, and refresh puts the active repo first', async ({ store }) => {
    const lines: string[] = [];
    const memento = { get: () => true, update: async () => undefined, keys: () => [] } as unknown as vscode.Memento;
    await copyOldSettings({ extension: { packageJSON: {} }, globalState: memento, workspaceState: memento } as unknown as vscode.ExtensionContext, {
      appendLine: (l: string) => void lines.push(l),
    } as unknown as vscode.OutputChannel);
    assert.deepEqual(lines, []);
    await waitFor('search', () => store.get(at('services/search')));
    await vscode.window.showTextDocument(vscode.Uri.file(at('services/search/README.md')));
    try {
      store.refreshAll();
      assert.equal(store.activeRepo()?.root, at('services/search'));
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });

  test('auto reveal takes a diff\'s modified side, and leaves files outside the workspace alone', async ({ autoReveal, explorer }) => {
    const config = vscode.workspace.getConfiguration('explorer');
    const outside = path.join(tmpdir(), 'outside-reveal.txt');
    writeFileSync(outside, '');
    await config.update('autoReveal', true, vscode.ConfigurationTarget.Global);
    try {
      await vscode.commands.executeCommand('workbench.view.extension.multiGitExplorer');
      await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(at('services/search/README.md')), vscode.Uri.file(at('docs/README.md')), 'diff');
      await waitFor('the modified side to be selected', () => treeOf(explorer).selection.some(n => n.uri.fsPath === at('docs/README.md')));
      await vscode.window.showTextDocument(vscode.Uri.file(outside));
      assert.equal(await autoReveal.revealActiveFile(), false);
    } finally {
      await config.update('autoReveal', undefined, vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      rmSync(outside, { force: true });
    }
  });

  test('a conflicted file opens as itself, with the options given; a repo not checked yet has no file letters', async ({ store, decorations }) => {
    const billing = at('services/billing');
    await waitFor('billing', () => store.get(billing)?.status);
    const conflicted: ExplorerNode = { uri: vscode.Uri.file(path.join(billing, 'README.md')), isDir: false, change: { path: 'README.md', letter: '!', staged: false, unstaged: true } };
    const { ran, restore } = intercept(['vscode.open']);
    try {
      await vscode.commands.executeCommand('multiGitExplorer.openChange', conflicted, { preview: false });
    } finally {
      restore();
    }
    assert.deepEqual(ran[0].slice(2), [{ preview: false }]);
    const unchecked = stub(store, 'repoContaining', (() => ({ root: '/unchecked' })) as never);
    try {
      assert.equal(decorations.provideFileDecoration(toViewUri('/unchecked/a.ts')), undefined);
    } finally {
      unchecked();
    }
  });

  test('while filtered, repo updates rebuild the tree a moment later and folder updates wait', async ({ store, explorer }) => {
    explorer.setFilters(['changes']);
    try {
      await new Promise<void>(resolve => {
        const sub = store.onDidChangeRepos(() => {
          sub.dispose();
          resolve();
        });
        store.refresh(at('services/api-gateway'));
      });
      await new Promise<void>(resolve => {
        const sub = store.onDidChangeFolder(() => {
          sub.dispose();
          resolve();
        });
        writeFileSync(at('docs', 'while-filtered.txt'), '');
      });
      const shows = (explorer as unknown as { showsFilesOf(repo: object): boolean }).showsFilesOf({});
      assert.equal(shows, false, 'a repo not checked yet has no files to show');
    } finally {
      explorer.setFilters([]);
      rmSync(at('docs', 'while-filtered.txt'), { force: true });
    }

    // When no row changes its selection, the focused row can't be found. Wait first
    // for the refresh above, which re-selects rows, so it isn't taken for the toggle.
    await new Promise(r => setTimeout(r, 1500));
    const quiet = intercept(['list.toggleSelection']);
    try {
      assert.equal(await explorer.focusedRow(), undefined);
    } finally {
      quiet.restore();
    }
  });

  test('removing a .gitignore forgets it and the ones below it', ({ explorer }) =>
    withScratch(async dir => {
      const config = vscode.workspace.getConfiguration('explorer');
      await config.update('excludeGitIgnore', true, vscode.ConfigurationTarget.Global);
      const list = async (rel = '.') => (await explorer.getChildren({ uri: vscode.Uri.file(path.join(dir, rel)), isDir: true })).map(n => path.basename(n.uri.fsPath));
      try {
        writeFileSync(path.join(dir, '.gitignore'), 'hidden.txt\n');
        writeFileSync(path.join(dir, 'sub', '.gitignore'), 'x\n');
        writeFileSync(path.join(dir, 'sub', 'hidden.txt'), '');
        await list();
        await list('sub');
        const files = (explorer as unknown as { ignoreFiles: Map<string, Map<string, unknown>> }).ignoreFiles;
        const known = () => [...(files.values().next().value?.keys() ?? [])];
        assert.ok(known().includes(path.join(dir, 'sub')));
        // Without listing the folder again, so it's the watcher that has them forgotten.
        rmSync(path.join(dir, '.gitignore'));
        await waitFor('both to be forgotten', () => !known().includes(dir) && !known().includes(path.join(dir, 'sub')), 10_000);
      } finally {
        await config.update('excludeGitIgnore', undefined, vscode.ConfigurationTarget.Global);
      }
    }));
}
