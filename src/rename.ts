import * as vscode from 'vscode';
import { OLD_EXTENSION_IDS, oldSettingName, scopesToCopy, type SettingScope } from './core/rename';

/**
 * Copies settings over from Multi-Repo Explorer, the extension's old name: user
 * settings once per machine, workspace settings once per workspace. Never throws.
 */
export async function copyOldSettings(context: vscode.ExtensionContext, log: vscode.OutputChannel): Promise<void> {
  try {
    await copyOldSettingsOrThrow(context);
  } catch (err) {
    log.appendLine(`Couldn't copy Multi-Repo Explorer settings: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const COPIED_KEY = 'multiGitExplorer.copiedOldSettings';

async function copyOldSettingsOrThrow(context: vscode.ExtensionContext): Promise<void> {
  const names = Object.keys(context.extension.packageJSON.contributes?.configuration?.properties ?? {});

  if (!context.globalState.get(COPIED_KEY)) {
    await copy(names, vscode.workspace.getConfiguration(), 'globalValue', vscode.ConfigurationTarget.Global);
    await context.globalState.update(COPIED_KEY, true);
  }

  if (vscode.workspace.workspaceFolders?.length && !context.workspaceState.get(COPIED_KEY)) {
    await copy(names, vscode.workspace.getConfiguration(), 'workspaceValue', vscode.ConfigurationTarget.Workspace);
    // Each folder of a multi-root workspace has settings of its own.
    if (vscode.workspace.workspaceFile) {
      for (const folder of vscode.workspace.workspaceFolders) {
        await copy(names, vscode.workspace.getConfiguration(undefined, folder.uri), 'workspaceFolderValue', vscode.ConfigurationTarget.WorkspaceFolder);
      }
    }
    await context.workspaceState.update(COPIED_KEY, true);
  }
}

async function copy(names: string[], config: vscode.WorkspaceConfiguration, scope: SettingScope, target: vscode.ConfigurationTarget): Promise<void> {
  for (const name of names) {
    const oldName = oldSettingName(name);
    if (!oldName) continue;
    const oldValues = config.inspect(oldName);
    if (scopesToCopy(oldValues, config.inspect(name), [scope]).length) {
      await config.update(name, oldValues![scope], target);
    }
  }
}

/** Offers to uninstall Multi-Repo Explorer if it's still installed, so there aren't two side bars. */
export async function offerToUninstallOld(): Promise<void> {
  const installed = OLD_EXTENSION_IDS.filter(id => vscode.extensions.getExtension(id));
  if (!installed.length) return;
  const choice = await vscode.window.showInformationMessage(
    'Multi-Repo Explorer is now called Multi-Git Explorer, and the old one is still installed. Uninstall it, so you don\'t get two side bars? Your settings were copied over.',
    'Uninstall',
  );
  if (choice !== 'Uninstall') return;
  for (const id of installed) {
    await vscode.commands.executeCommand('workbench.extensions.uninstallExtension', id);
  }
  const reload = await vscode.window.showInformationMessage('Multi-Repo Explorer was uninstalled. Reload the window to finish.', 'Reload Window');
  if (reload) await vscode.commands.executeCommand('workbench.action.reloadWindow');
}
