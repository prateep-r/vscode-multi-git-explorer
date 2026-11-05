import * as vscode from 'vscode';
import type { RepoStore } from '../store';

/**
 * Left: branch of the repo the active file belongs to.
 * Right: totals across all repos, and progress while the first check runs.
 */
export class StatusBar implements vscode.Disposable {
  private readonly current = vscode.window.createStatusBarItem('multiRepoGit.current', vscode.StatusBarAlignment.Left, 99);
  private readonly totals = vscode.window.createStatusBarItem('multiRepoGit.totals', vscode.StatusBarAlignment.Right, 100);
  private readonly disposables: vscode.Disposable[];
  private updateTimer?: NodeJS.Timeout;

  constructor(private readonly store: RepoStore) {
    this.current.name = 'Multi-Repo Explorer: Current Repo';
    this.totals.name = 'Multi-Repo Explorer: All Repos';
    this.totals.command = 'multiRepoGit.repos.focus';
    this.disposables = [
      this.current,
      this.totals,
      store.onDidChangeRepos(() => this.scheduleUpdate()),
      store.onDidDiscover(() => this.scheduleUpdate()),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateCurrent()),
    ];
    this.update();
  }

  dispose(): void {
    clearTimeout(this.updateTimer);
    this.disposables.forEach(d => d.dispose());
  }

  private scheduleUpdate(): void {
    this.updateTimer ??= setTimeout(() => {
      this.updateTimer = undefined;
      this.update();
    }, 150);
  }

  private update(): void {
    this.updateCurrent();
    this.updateTotals();
  }

  private updateCurrent(): void {
    const repo = this.store.activeRepo();
    if (!repo) {
      this.current.hide();
      return;
    }
    const { view } = repo;
    const sync = [view.ahead && `↑${view.ahead}`, view.behind && `↓${view.behind}`].filter(Boolean).join(' ');
    this.current.text = `$(git-branch) ${repo.name}: ${view.branchLabel}${sync ? ` ${sync}` : ''}`;
    this.current.tooltip = view.tooltip;
    this.current.command = { command: 'multiRepoGit.openInScm', title: 'Open in Source Control', arguments: [vscode.Uri.file(repo.root)] };
    this.current.show();
  }

  private updateTotals(): void {
    const repos = this.store.all();
    if (repos.length === 0) {
      this.totals.hide();
      return;
    }
    const count = (...groups: string[]) => repos.filter(r => groups.includes(r.view.group)).length;
    const parts = [
      [count('conflict', 'error'), '$(warning)'],
      [count('dirty'), '$(circle-filled)'],
      [count('unpushed'), '$(arrow-up)'],
      [count('behind'), '$(arrow-down)'],
    ]
      .filter(([n]) => n)
      .map(([n, icon]) => `${icon} ${n}`);

    const { done, total } = this.store.progress();
    if (done < total) parts.push(`$(sync~spin) ${done}/${total}`);
    if (parts.length === 0) parts.push(`$(check) ${total}`);

    this.totals.text = parts.join('  ');
    this.totals.tooltip = [
      `${total} repos`,
      `${count('conflict')} with conflicts or an unfinished operation`,
      `${count('dirty')} with uncommitted changes`,
      `${count('unpushed')} not pushed`,
      `${count('behind')} behind remote`,
      `${count('clean')} clean`,
      done < total ? `Checking… ${done} of ${total} done` : '',
    ]
      .filter(Boolean)
      .join('\n');
    this.totals.show();
  }
}
