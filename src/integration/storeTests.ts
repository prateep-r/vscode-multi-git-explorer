// Integration tests of the repo store: repos appearing and going away,
// failed checks, window focus, and its settings.
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { mkdirSync, rmSync } from 'fs';
import * as vscode from 'vscode';
import { at, stub, test, waitFor } from './harness';

export function registerStoreTests(): void {
  test('repos made or removed on disk, such as by git clone, are found without Refresh', async ({ store }) => {
    const cloned = at('docs', 'cloned');
    rmSync(cloned, { recursive: true, force: true });
    try {
      mkdirSync(cloned);
      execFileSync('git', ['init', '-q'], { cwd: cloned });
      await waitFor('the new repo', () => store.get(cloned));
      rmSync(at('docs', 'cloned', '.git'), { recursive: true });
      await waitFor('the repo to go when .git does', () => !store.get(cloned));
      execFileSync('git', ['init', '-q'], { cwd: cloned });
      await waitFor('the repo again', () => store.get(cloned));
      rmSync(cloned, { recursive: true });
      await waitFor('the repo to go with its folder', () => !store.get(cloned));
    } finally {
      rmSync(cloned, { recursive: true, force: true });
    }
  });

  test('a failed check shows git\'s error until the next check works', async ({ store }) => {
    const root = at('services', 'search');
    const config = vscode.workspace.getConfiguration('git');
    await config.update('path', '/nonexistent/git', vscode.ConfigurationTarget.Global);
    try {
      store.refresh(root);
      await waitFor('the error', () => store.get(root)?.error);
    } finally {
      await config.update('path', undefined, vscode.ConfigurationTarget.Global);
    }
    store.refresh(root);
    await waitFor('the error to clear', () => store.get(root)?.error === undefined && store.get(root)?.status);
    store.refresh(at('not', 'a', 'repo'));
  });

  test('coming back to the window re-checks repos, at most every 10 seconds, per refreshOnFocus', async ({ store }) => {
    let refreshed = 0;
    const restore = stub(store, 'refreshAll', () => void refreshed++);
    const focus = () => (store as unknown as { onWindowFocus(): void }).onWindowFocus();
    const config = vscode.workspace.getConfiguration('multiGitExplorer');
    try {
      (store as unknown as { lastFocusRefresh: number }).lastFocusRefresh = 0;
      focus();
      focus();
      assert.equal(refreshed, 1, 'not again within 10 seconds');
      (store as unknown as { lastFocusRefresh: number }).lastFocusRefresh = 0;
      await config.update('refreshOnFocus', false, vscode.ConfigurationTarget.Global);
      focus();
      assert.equal(refreshed, 1, 'off');
    } finally {
      await config.update('refreshOnFocus', undefined, vscode.ConfigurationTarget.Global);
      restore();
    }
  });

  test('settings take effect at once: concurrency, untracked files and background refresh', async ({ store }) => {
    let refreshed = 0;
    const restore = stub(store, 'refreshAll', () => void refreshed++);
    const config = vscode.workspace.getConfiguration('multiGitExplorer');
    const queue = (store as unknown as { queue: { concurrency: number } }).queue;
    const timer = () => (store as unknown as { backgroundTimer?: NodeJS.Timeout }).backgroundTimer;
    try {
      await config.update('maxConcurrency', 2, vscode.ConfigurationTarget.Global);
      assert.equal(queue.concurrency, 2);
      await config.update('countUntracked', false, vscode.ConfigurationTarget.Global);
      assert.equal(refreshed, 1, 'every repo is checked again');
      await config.update('backgroundRefreshMinutes', 0, vscode.ConfigurationTarget.Global);
      const off = timer();
      await config.update('backgroundRefreshMinutes', 1, vscode.ConfigurationTarget.Global);
      assert.notEqual(timer(), off, 'a new timer');
    } finally {
      for (const key of ['maxConcurrency', 'countUntracked', 'backgroundRefreshMinutes']) {
        await config.update(key, undefined, vscode.ConfigurationTarget.Global);
      }
      restore();
    }
  });
}
