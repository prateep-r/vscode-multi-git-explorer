import * as vscode from 'vscode';
import { GROUP_LABELS, GROUP_ORDER, type GroupKey } from '../core/state';
import type { RepoEntry, RepoStore } from '../store';
import { toReposViewUri } from './viewUri';

export type ReposNode = { type: 'group'; key: GroupKey } | { type: 'repo'; root: string };

const GROUP_ICONS: Record<GroupKey, [string, string]> = {
  conflict: ['warning', 'multiGitExplorer.conflictForeground'],
  error: ['error', 'multiGitExplorer.errorForeground'],
  dirty: ['circle-filled', 'multiGitExplorer.dirtyForeground'],
  unpushed: ['arrow-up', 'multiGitExplorer.aheadForeground'],
  behind: ['arrow-down', 'multiGitExplorer.behindForeground'],
  checking: ['sync', 'multiGitExplorer.pendingForeground'],
  clean: ['check', 'gitDecoration.addedResourceForeground'],
};

/** Groups that start collapsed because they are usually long and need no attention. */
const COLLAPSED_GROUPS = new Set<GroupKey>(['clean', 'checking']);

const REFRESH_DEBOUNCE_MS = 200;

/** All repos grouped by what needs attention, problems first. */
export class ReposViewProvider implements vscode.TreeDataProvider<ReposNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<ReposNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly groupNodes = new Map(GROUP_ORDER.map(key => [key, { type: 'group', key } as ReposNode]));
  private readonly repoNodes = new Map<string, ReposNode>();
  private filterText = '';
  private refreshTimer?: NodeJS.Timeout;
  private treeView?: vscode.TreeView<ReposNode>;
  private readonly disposables: vscode.Disposable[];

  constructor(private readonly store: RepoStore) {
    this.disposables = [
      store.onDidChangeRepos(() => this.scheduleRefresh()),
      store.onDidDiscover(() => this.scheduleRefresh()),
      this._onDidChangeTreeData,
    ];
  }

  dispose(): void {
    clearTimeout(this.refreshTimer);
    this.disposables.forEach(d => d.dispose());
  }

  attach(treeView: vscode.TreeView<ReposNode>): void {
    this.treeView = treeView;
    this.updateTitle();
  }

  get filter(): string {
    return this.filterText;
  }

  setFilter(text: string): void {
    this.filterText = text.trim().toLowerCase();
    void vscode.commands.executeCommand('setContext', 'multiGitExplorer.filtered', this.filterText !== '');
    if (this.treeView) this.treeView.message = this.filterText ? `Filter: "${text.trim()}"` : undefined;
    this._onDidChangeTreeData.fire(undefined);
    this.updateTitle();
  }

  getChildren(node?: ReposNode): ReposNode[] {
    const repos = this.visibleRepos();
    if (!node) {
      return GROUP_ORDER.filter(key => repos.some(r => r.view.group === key)).map(key => this.groupNodes.get(key)!);
    }
    if (node.type === 'repo') return [];
    return repos
      .filter(r => r.view.group === node.key)
      .sort((a, b) => this.label(a).localeCompare(this.label(b), undefined, { numeric: true }))
      .map(r => this.repoNode(r.root));
  }

  getParent(node: ReposNode): ReposNode | undefined {
    if (node.type === 'group') return undefined;
    const repo = this.store.get(node.root);
    return repo ? this.groupNodes.get(repo.view.group) : undefined;
  }

  getTreeItem(node: ReposNode): vscode.TreeItem {
    if (node.type === 'group') {
      const count = this.visibleRepos().filter(r => r.view.group === node.key).length;
      const item = new vscode.TreeItem(
        GROUP_LABELS[node.key],
        COLLAPSED_GROUPS.has(node.key) ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded,
      );
      item.id = `group:${node.key}`;
      item.description = String(count);
      const [icon, color] = GROUP_ICONS[node.key];
      item.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
      item.contextValue = 'group';
      return item;
    }

    const repo = this.store.get(node.root)!;
    const item = new vscode.TreeItem(toReposViewUri(repo.root), vscode.TreeItemCollapsibleState.None);
    item.id = `repo:${repo.root}`;
    item.label = this.label(repo);
    item.iconPath = new vscode.ThemeIcon('repo');
    item.description = repo.view.description;
    item.tooltip = repo.view.tooltip;
    item.contextValue = repo.view.contextValue;
    return item;
  }

  private visibleRepos(): RepoEntry[] {
    const repos = this.store.all();
    if (!this.filterText) return repos;
    return repos.filter(
      r => this.label(r).toLowerCase().includes(this.filterText) || r.view.branchLabel.toLowerCase().includes(this.filterText),
    );
  }

  /** Path relative to its workspace folder, so same-named repos stay apart. */
  private label(repo: RepoEntry): string {
    // A repo that is a workspace folder comes back as its full path, so it's named by its folder.
    const relative = vscode.workspace.asRelativePath(repo.root, false);
    return relative === repo.root ? repo.name : relative;
  }

  private repoNode(root: string): ReposNode {
    let node = this.repoNodes.get(root);
    if (!node) {
      node = { type: 'repo', root };
      this.repoNodes.set(root, node);
    }
    return node;
  }

  private scheduleRefresh(): void {
    this.refreshTimer ??= setTimeout(() => {
      this.refreshTimer = undefined;
      this._onDidChangeTreeData.fire(undefined);
      this.updateTitle();
    }, REFRESH_DEBOUNCE_MS);
  }

  private updateTitle(): void {
    if (!this.treeView) return;
    const total = this.store.all().length;
    const shown = this.visibleRepos().length;
    this.treeView.description = this.filterText ? `${shown} of ${total}` : String(total);
  }
}
