// Shared by the integration test files: the sample workspace, the list of
// tests, and helpers that wait, make scratch folders, and stand in for the user.
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { MultiGitExplorerApi } from '../extension';
import type { ExplorerNode } from '../views/repoExplorer';

export const sample = process.env.SAMPLE_WORKSPACE!;
export const at = (...parts: string[]) => path.join(sample, ...parts);

export async function waitFor<T>(what: string, check: () => T | undefined | false, timeoutMs = 30_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 50));
  }
}

export const tests: [string, (api: MultiGitExplorerApi) => Promise<void>][] = [];
export const test = (name: string, fn: (api: MultiGitExplorerApi) => Promise<void>) => tests.push([name, fn]);

/**
 * Replaces `object[key]` until the returned function puts it back. Tests use
 * it to answer VS Code's dialogs and pickers, which they can't click.
 */
export function stub<T extends object, K extends keyof T>(object: T, key: K, value: T[K]): () => void {
  // Some, like workspace.workspaceFolders, are getters, so redefine rather than assign.
  const own = Object.getOwnPropertyDescriptor(object, key);
  Object.defineProperty(object, key, { value, configurable: true, writable: true, enumerable: own?.enumerable ?? true });
  return () => {
    if (own) Object.defineProperty(object, key, own);
    else delete object[key];
  };
}

/** Warning dialogs shown by `withScratch` tests, which answer each with its last button. */
export const dialogs: string[] = [];

/** Runs `fn` with a scratch folder in docs/ holding a.txt and sub/, and settings that skip confirmations. */
export async function withScratch(fn: (dir: string, node: (rel: string, isDir?: boolean) => ExplorerNode) => Promise<void>) {
  const dir = at('docs', 'scratch');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(dir, 'sub'), { recursive: true });
  writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  const settings: [string, string, unknown][] = [
    ['explorer', 'confirmDelete', false],
    ['explorer', 'confirmDragAndDrop', false],
    ['files', 'enableTrash', false],
  ];
  for (const [section, key, value] of settings) {
    await vscode.workspace.getConfiguration(section).update(key, value, vscode.ConfigurationTarget.Global);
  }
  const clipboard = await vscode.env.clipboard.readText();
  // Tests can't show modal dialogs, so answer them as the user would.
  const window = vscode.window as { showWarningMessage: (...args: unknown[]) => Thenable<unknown> };
  const showWarning = window.showWarningMessage;
  window.showWarningMessage = async (message: unknown, ...rest: unknown[]) => {
    dialogs.push(String(message));
    return rest[rest.length - 1];
  };
  dialogs.length = 0;
  try {
    await fn(dir, (rel, isDir = false) => ({ uri: vscode.Uri.file(path.join(dir, rel)), isDir }));
  } finally {
    window.showWarningMessage = showWarning;
    await vscode.env.clipboard.writeText(clipboard);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    for (const [section, key] of settings) {
      await vscode.workspace.getConfiguration(section).update(key, undefined, vscode.ConfigurationTarget.Global);
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs the registered tests, or with TEST_GREP only those whose names contain it. */
export async function runAll(kind: string): Promise<void> {
  const api = await vscode.extensions.getExtension<MultiGitExplorerApi>('prateep-r.multi-git-explorer')!.activate();
  let failed = 0;
  const grep = process.env.TEST_GREP;
  const chosen = grep ? tests.filter(([name]) => name.includes(grep)) : tests;
  for (const [name, fn] of chosen) {
    try {
      await fn(api);
      console.log(`  ✔ ${name}`);
    } catch (error) {
      failed++;
      const message = error instanceof Error ? error.message : String(error);
      console.log(`  ✘ ${name}\n    ${message.split('\n').join('\n    ')}`);
    }
  }
  if (failed) throw new Error(`${failed} of ${chosen.length} ${kind} tests failed`);
  console.log(`  ${chosen.length} ${kind} tests passed`);
}
