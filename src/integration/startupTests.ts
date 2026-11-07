// Integration tests of what happens when the extension starts: copying
// Multi-Repo Explorer's settings, offering to uninstall it, and showing the
// side bar.
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { showOnStartup } from '../extension';
import { copyOldSettings, offerToUninstallOld } from '../rename';
import { stub, test } from './harness';

type Scoped = { globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown };

/** A Memento kept in memory. */
function memento(): vscode.Memento {
  const values = new Map<string, unknown>();
  return {
    keys: () => [...values.keys()],
    get: (key: string) => values.get(key),
    update: async (key: string, value: unknown) => void values.set(key, value),
  } as vscode.Memento;
}

/** Settings as `getConfiguration` would see them, recording what's written. */
function fakeConfiguration(values: Record<string, Scoped>, written: string[]) {
  return (() => ({
    inspect: (name: string) => values[name],
    update: async (name: string, value: unknown, target: vscode.ConfigurationTarget) => void written.push(`${name}=${value}@${target}`),
  })) as unknown as typeof vscode.workspace.getConfiguration;
}

const context = (globalState = memento(), workspaceState = memento()) =>
  ({
    extension: { packageJSON: { contributes: { configuration: { properties: { 'multiGitExplorer.scanDepth': {}, 'multiGitExplorer.exclude': {}, 'other.setting': {} } } } } },
    globalState,
    workspaceState,
  }) as unknown as vscode.ExtensionContext;

const log = () => {
  const lines: string[] = [];
  return { lines, channel: { appendLine: (line: string) => void lines.push(line) } as unknown as vscode.OutputChannel };
};

export function registerStartupTests(): void {
  test('Multi-Repo Explorer settings are copied once per machine and once per workspace, never over new ones', async () => {
    const written: string[] = [];
    const values: Record<string, Scoped> = {
      'multiRepoExplorer.scanDepth': { globalValue: 4, workspaceValue: 2, workspaceFolderValue: 1 },
      'multiGitExplorer.scanDepth': {},
      'multiRepoExplorer.exclude': { globalValue: ['x'] },
      'multiGitExplorer.exclude': { globalValue: ['y'] },
    };
    const { lines, channel } = log();
    const ctx = context();
    const restore = [stub(vscode.workspace, 'getConfiguration', fakeConfiguration(values, written))];
    try {
      await copyOldSettings(ctx, channel);
      assert.deepEqual(written, ['multiGitExplorer.scanDepth=4@1', 'multiGitExplorer.scanDepth=2@2'], 'not over the new exclude');
      written.length = 0;
      await copyOldSettings(ctx, channel);
      assert.deepEqual(written, [], 'only once');

      restore.push(stub(vscode.workspace, 'workspaceFile', vscode.Uri.file('/ws.code-workspace')));
      await copyOldSettings(context(), channel);
      assert.deepEqual(written, ['multiGitExplorer.scanDepth=4@1', 'multiGitExplorer.scanDepth=2@2', 'multiGitExplorer.scanDepth=1@3'], 'each folder of a multi-root workspace');
      written.length = 0;
      restore.push(stub(vscode.workspace, 'workspaceFolders', []));
      await copyOldSettings(context(), channel);
      assert.deepEqual(written, ['multiGitExplorer.scanDepth=4@1'], 'no workspace, no workspace settings');
    } finally {
      restore.reverse().forEach(r => r());
    }
    assert.deepEqual(lines, []);

    const failing = { ...memento(), get: () => undefined, update: async () => Promise.reject(new Error('storage is full')) } as vscode.Memento;
    await copyOldSettings(context(failing), channel);
    assert.deepEqual(lines, ["Couldn't copy Multi-Repo Explorer settings: storage is full"], 'never throws');
  });

  test('offers to uninstall Multi-Repo Explorer, then to reload', async () => {
    const asked: string[] = [];
    const ran: string[] = [];
    let answers: (string | undefined)[] = [];
    const execute = vscode.commands.executeCommand;
    const getExtension = vscode.extensions.getExtension;
    let installed = ['prateep-r.multi-repo-explorer'];
    const restore = [
      stub(vscode.extensions, 'getExtension', ((id: string) => (installed.includes(id) ? { id } : getExtension(id))) as never),
      stub(vscode.window, 'showInformationMessage', (async (text: string) => {
        asked.push(text);
        return answers.shift();
      }) as never),
      stub(vscode.commands, 'executeCommand', (async (id: string, ...args: unknown[]) => {
        if (id !== 'workbench.extensions.uninstallExtension' && id !== 'workbench.action.reloadWindow') return execute(id, ...args);
        ran.push([id, ...args].join(' '));
        return undefined;
      }) as never),
    ];
    try {
      answers = [undefined];
      await offerToUninstallOld();
      assert.equal(asked.length, 1);
      assert.deepEqual(ran, [], 'declined');
      answers = ['Uninstall', undefined];
      await offerToUninstallOld();
      assert.deepEqual(ran, ['workbench.extensions.uninstallExtension prateep-r.multi-repo-explorer']);
      answers = ['Uninstall', 'Reload Window'];
      await offerToUninstallOld();
      assert.equal(ran.at(-1), 'workbench.action.reloadWindow');
      asked.length = 0;
      installed = [];
      await offerToUninstallOld();
      assert.deepEqual(asked, [], 'nothing to offer');
    } finally {
      restore.forEach(r => r());
    }
  });

  test('the side bar opens on Multi-Git Explorer at startup, per multiGitExplorer.showOnStartup', async () => {
    const ran: string[] = [];
    const execute = vscode.commands.executeCommand;
    const config = vscode.workspace.getConfiguration('multiGitExplorer');
    const restore = [
      stub(vscode.commands, 'executeCommand', (async (id: string, ...args: unknown[]) => {
        if (!id.startsWith('workbench.')) return execute(id, ...args);
        ran.push(id);
        return undefined;
      }) as never),
    ];
    try {
      await vscode.window.showTextDocument(vscode.Uri.file(`${process.env.SAMPLE_WORKSPACE}/docs/README.md`));
      await showOnStartup();
      assert.deepEqual(ran, ['workbench.view.extension.multiGitExplorer', 'workbench.action.focusActiveEditorGroup'], 'the editor keeps focus');
      ran.length = 0;
      await execute('workbench.action.closeAllEditors');
      await showOnStartup();
      assert.deepEqual(ran, ['workbench.view.extension.multiGitExplorer']);
      ran.length = 0;
      await config.update('showOnStartup', false, vscode.ConfigurationTarget.Global);
      await showOnStartup();
      await config.update('showOnStartup', undefined, vscode.ConfigurationTarget.Global);
      restore.push(stub(vscode.workspace, 'workspaceFolders', undefined));
      await showOnStartup();
      assert.deepEqual(ran, [], 'off, or no folder open');
    } finally {
      restore.reverse().forEach(r => r());
      await execute('workbench.action.closeAllEditors');
    }
  });
}
