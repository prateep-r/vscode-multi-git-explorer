// Integration tests of the repo store: repos appearing and going away,
// failed checks, window focus, and its settings.
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { mkdirSync, rmSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { LARGE_WORKSPACE_REPOS, RepoStore, STARTUP_PAUSE_MS, type RepoEntry } from '../store';
import { RepoDecorationProvider } from '../views/decorations';
import { toViewUri } from '../views/viewUri';
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

  test('looking for changes re-checks only repos whose .git changed, that failed, or that the active editor is in', async ({ store }) => {
    await waitFor('all status checks', () => store.progress().done === store.all().length && store.all().length > 0);
    const queue = (store as unknown as { queue: { onIdle(): Promise<void> } }).queue;
    await queue.onIdle();
    const inner = store as unknown as { check(entry: RepoEntry): Promise<void> };
    const check = inner.check;
    const checked: string[] = [];
    const restore = stub(inner, 'check', (entry: RepoEntry) => {
      checked.push(entry.root);
      return check.call(store, entry);
    });
    const [changed, failed] = [at('services', 'notification'), at('frontend', 'web-app')];
    try {
      await store.refreshChanged();
      await queue.onIdle();
      assert.deepEqual(checked, [], 'nothing changed');

      store.get(changed)!.fingerprint = 'stale';
      store.get(failed)!.error = 'git status timed out';
      await vscode.window.showTextDocument(vscode.Uri.file(at('services', 'search', 'README.md')));
      await store.refreshChanged();
      await queue.onIdle();
      assert.deepEqual(checked.sort(), [failed, changed, at('services', 'search')].sort());
      assert.equal(store.get(failed)!.error, undefined);
    } finally {
      restore();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });

  test('in a large workspace, the first search checks the repos on screen at once, and the rest after a pause', async () => {
    const lines: string[] = [];
    const fresh = new RepoStore({ appendLine: (l: string) => void lines.push(l) } as unknown as vscode.OutputChannel);
    const added = at('docs', 'added-later');
    rmSync(added, { recursive: true, force: true });
    try {
      await fresh.discover();
      assert.ok(fresh.isLarge(), `the sample has more than ${LARGE_WORKSPACE_REPOS} repos`);
      // A repo that goes away during the pause isn't checked when it ends.
      const gone = fresh.all()[1];
      (fresh as unknown as { repos: Map<string, RepoEntry> }).repos.delete(gone.root);
      const repos = fresh.all();
      assert.ok(repos.length > 0 && repos.every(r => !r.requested), 'none checked yet');
      // Coming back to the window during the pause leaves them to the coming check.
      await fresh.refreshChanged();
      assert.ok(repos.every(r => !r.requested), 'still none');
      // Drawing a repo's row asks for its decoration, which has it checked.
      const decorations = new RepoDecorationProvider(fresh);
      decorations.provideFileDecoration(toViewUri(repos[0].root));
      decorations.dispose();
      await waitFor('the repo on screen', () => repos[0].status);
      assert.ok(repos.slice(1).every(r => !r.status), 'the rest wait');
      await waitFor('the rest', () => fresh.progress().done === repos.length);
      assert.ok(!gone.requested, 'not the one that went away');

      mkdirSync(added);
      execFileSync('git', ['init', '-q'], { cwd: added });
      await fresh.discover();
      assert.ok(fresh.get(added)?.requested, 'repos found later are checked at once');
    } finally {
      fresh.dispose();
      rmSync(added, { recursive: true, force: true });
    }
    // A workspace of up to LARGE_WORKSPACE_REPOS repos checks them all at once, as before.
    const small = new RepoStore({ appendLine: () => undefined } as unknown as vscode.OutputChannel);
    const restore = stub(small, 'isLarge', () => false);
    try {
      await small.discover();
      assert.ok(small.all().length > 0 && small.all().every(r => r.requested));
    } finally {
      restore();
      small.dispose();
    }
    // Disposed during the pause, it checks nothing.
    const early = new RepoStore({ appendLine: () => undefined } as unknown as vscode.OutputChannel);
    await early.discover();
    early.dispose();
    await new Promise(r => setTimeout(r, STARTUP_PAUSE_MS + 500));
    assert.ok(early.all().every(r => !r.requested));
  });

  test('focus and the background tick re-check every repo as before, and in a large workspace only the changed ones, with all every 30 minutes', async ({ store }) => {
    await waitFor('the repos', () => store.isLarge());
    const calls: string[] = [];
    const inner = store as unknown as { onWindowFocus(): void; onBackgroundTick(): void; lastFocusRefresh: number; lastFullRefresh: number };
    const restore = [
      stub(store, 'refreshAll', () => void calls.push('all')),
      stub(store, 'refreshChanged', async () => void calls.push('changed')),
    ];
    const focus = () => {
      inner.lastFocusRefresh = 0;
      inner.onWindowFocus();
    };
    try {
      restore.push(stub(store, 'isLarge', () => false));
      focus();
      inner.onBackgroundTick();
      assert.deepEqual(calls.splice(0), ['all', 'all'], 'a workspace of up to 100 repos');
      restore.pop()!();

      assert.ok(store.isLarge(), 'the 300-repo sample');
      inner.lastFullRefresh = Date.now();
      focus();
      inner.onBackgroundTick();
      assert.deepEqual(calls.splice(0), ['changed', 'changed']);
      inner.lastFullRefresh = Date.now() - 31 * 60_000;
      inner.onBackgroundTick();
      assert.deepEqual(calls.splice(0), ['all'], 'every repo, half an hour after the last time');
    } finally {
      restore.reverse().forEach(r => r());
    }
    // Refresh counts as checking every repo.
    const before = inner.lastFullRefresh;
    const quiet = stub(store, 'refresh', () => undefined);
    try {
      store.refreshAll();
    } finally {
      quiet();
    }
    assert.ok(inner.lastFullRefresh > before);
  });

  test('a check of a submodule re-checks the repo it is in, whose status shows it', async ({ store }) => {
    const parent = at('docs', 'with-sub');
    rmSync(parent, { recursive: true, force: true });
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'protocol.file.allow=always', ...args], { cwd, stdio: 'ignore' });
    try {
      mkdirSync(parent);
      git(parent, 'init', '-q');
      git(parent, 'submodule', 'add', '-q', at('services', 'search'), 'search');
      const sub = path.join(parent, 'search');
      await store.discover();
      await waitFor('both repos', () => store.get(parent) && store.get(sub)?.isSubmodule);
      const queue = (store as unknown as { queue: { onIdle(): Promise<void> } }).queue;
      // Let the checks set off by the watcher, for the files git just wrote, run first.
      await new Promise(r => setTimeout(r, 1500));
      await queue.onIdle();
      const inner = store as unknown as { check(entry: RepoEntry): Promise<void> };
      const check = inner.check;
      const checked: string[] = [];
      const restore = stub(inner, 'check', (entry: RepoEntry) => {
        checked.push(entry.root);
        return check.call(store, entry);
      });
      try {
        store.refresh(sub);
        await queue.onIdle();
        await new Promise(r => setTimeout(r, 200));
        await queue.onIdle();
        assert.deepEqual(checked, [sub, parent]);
        checked.length = 0;
        store.refresh(parent);
        await queue.onIdle();
        assert.deepEqual(checked, [parent], 'not the other way round');
      } finally {
        restore();
      }
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test('coming back to the window looks for changes, at most every 10 seconds, per refreshOnFocus', async ({ store }) => {
    let refreshed = 0;
    const restore = stub(store, 'refreshChanged', async () => void refreshed++);
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
