// Measures what VS Code asks of the extension to draw the file tree: every
// row's children, tree item and decorations, across the whole 300-repo sample.
// The limits are loose, to catch a change that makes drawing much slower.
import assert from 'node:assert/strict';
import type { ExplorerNode } from '../views/repoExplorer';
import { at, test, waitFor } from './harness';

export function registerPerformanceTests(): void {
  test('drawing every row of the 300-repo sample, with its decorations, is quick', async ({ store, explorer, decorations, problems, items, cut }) => {
    await waitFor('all status checks', () => store.progress().done === store.all().length && store.all().length > 0);
    const providers = [decorations, problems, items, cut];
    const rows: ExplorerNode[] = [];
    let started = Date.now();
    const queue = await explorer.getChildren(undefined);
    while (queue.length) {
      const node = queue.shift()!;
      rows.push(node);
      const item = explorer.getTreeItem(node);
      for (const provider of providers) provider.provideFileDecoration(item.resourceUri!);
      if (node.isDir) queue.push(...(await explorer.getChildren(node)));
    }
    const firstDraw = Date.now() - started;

    // Drawn again, as after a refresh, everything is known already.
    started = Date.now();
    for (const node of rows) {
      const item = explorer.getTreeItem(node);
      for (const provider of providers) provider.provideFileDecoration(item.resourceUri!);
    }
    const redraw = Date.now() - started;

    started = Date.now();
    for (let i = 0; i < 20; i++) for (const node of rows) store.repoContaining(node.uri.fsPath);
    const lookups = Date.now() - started;
    console.log(`    ${rows.length} rows: first draw ${firstDraw} ms, redraw ${redraw} ms, ${rows.length * 20} repo lookups ${lookups} ms`);
    assert.ok(rows.some(n => n.uri.fsPath === at('archive')), 'walked the whole tree');
    assert.ok(firstDraw < 20_000 && redraw < 2_000, `drawing took ${firstDraw} ms, then ${redraw} ms`);
  });
}
