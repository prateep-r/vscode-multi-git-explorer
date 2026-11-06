// Checks package.json's menus and keyboard shortcuts against the rows the
// views show, without starting VS Code: which commands each kind of row gets
// in its right-click menu.
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import { describeRepo } from '../core/state';

interface MenuItem {
  command: string;
  when?: string;
  group?: string;
}

const manifest = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
const contributes = manifest.contributes;
const itemMenu: MenuItem[] = contributes.menus['view/item/context'];

/**
 * Evaluates the when-clauses used in this manifest: terms joined by `&&`,
 * each `key == value`, `key =~ /regex/`, `key` or `!key`.
 */
function matches(when: string | undefined, context: Record<string, string | boolean>): boolean {
  if (!when) return true;
  return when.split(/\s*&&\s*/).every(term => {
    const regex = /^(\S+)\s*=~\s*\/(.*)\/([a-z]*)$/.exec(term);
    if (regex) return new RegExp(regex[2], regex[3]).test(String(context[regex[1]] ?? ''));
    const equals = /^(\S+)\s*==\s*(\S+)$/.exec(term);
    if (equals) return String(context[equals[1]]) === equals[2];
    if (term.startsWith('!')) return !context[term.slice(1)];
    return Boolean(context[term]);
  });
}

/** The command names (without the prefix) in the right-click menu of a row. */
function menuFor(view: string, viewItem: string, extra: Record<string, boolean> = {}): string[] {
  const context = { view, viewItem, isMac: true, ...extra };
  return itemMenu.filter(i => i.group !== 'inline' && !i.group?.startsWith('inline') && matches(i.when, context)).map(i => i.command.replace('multiRepoExplorer.', ''));
}

const FILES = 'multiRepoExplorer.explorer';
const REPOS = 'multiRepoExplorer.repos';
const CHATS = { 'multiRepoExplorer.has.claude': true, 'multiRepoExplorer.has.codex': true };
const repoRow = describeRepo({
  name: 'app',
  isSubmodule: false,
  cheap: { branch: 'main', hasRemote: true },
  status: {
    branch: { detached: false, head: 'main', upstream: 'origin/main', ahead: 1, behind: 0 },
    stash: 0, modified: 0, staged: 0, untracked: 0, conflicted: 0, changedFiles: 0, files: [],
  },
}).contextValue;

test('every menu item and shortcut uses a declared command', () => {
  const declared = new Set(contributes.commands.map((c: { command: string }) => c.command));
  const used = [
    ...Object.values(contributes.menus).flat().map(i => (i as MenuItem).command).filter(Boolean),
    ...contributes.keybindings.map((k: { command: string }) => k.command),
  ];
  for (const command of used) assert.ok(declared.has(command), command);
});

test('menu items only show in our own views', () => {
  for (const item of itemMenu) assert.match(item.when ?? '', /\bview (==|=~)/, `${item.command} is limited to a view`);
});

test('no row gets the same command twice', () => {
  for (const [view, row] of [[FILES, repoRow], [REPOS, repoRow], [FILES, 'file'], [FILES, 'folder']]) {
    const menu = menuFor(view, row, CHATS);
    assert.deepEqual(menu.filter((c, i) => menu.indexOf(c) !== i), [], `${row} in ${view}`);
  }
});

test('a repo row gets git commands and file commands', () => {
  const menu = menuFor(FILES, `${repoRow} hosted`);
  for (const c of ['switchBranch', 'openInScm', 'fetch', 'pull', 'push', 'copyToAiChat', 'newFile', 'findInFolder', 'cut', 'paste', 'copyRemoteUrl', 'rename', 'delete', 'revealInFinder']) {
    assert.ok(menu.includes(c), c);
  }
  assert.ok(!menu.includes('openToSide'), 'files only');
  assert.ok(!menu.includes('openTerminal'), 'Files uses Open in Integrated Terminal instead');
  assert.ok(menuFor(REPOS, repoRow).includes('openTerminal'));
  assert.ok(!menuFor(REPOS, repoRow).includes('rename'), 'Git Repositories has no file commands');
});

test('a file row gets file commands but no git commands', () => {
  const menu = menuFor(FILES, 'file', CHATS);
  for (const c of ['addTo.claude', 'addTo.codex', 'copyToAiChat', 'openToSide', 'selectForCompare', 'openTimeline', 'copy', 'rename', 'delete']) {
    assert.ok(menu.includes(c), c);
  }
  for (const c of ['switchBranch', 'fetch', 'findInFolder', 'newFile', 'copyRemoteUrl']) assert.ok(!menu.includes(c), c);
  assert.ok(menuFor(FILES, 'file hosted').includes('copyRemoteUrl'), 'links need a remote');
  assert.ok(menuFor(FILES, 'file', { 'multiRepoExplorer.compareSelected': true }).includes('compareWithSelected'));
});

test('a deleted file can be linked and its path copied, but not opened or changed', () => {
  const menu = menuFor(FILES, 'file change deleted hosted', CHATS);
  for (const c of ['openChange', 'copyPath', 'copyRelativePath', 'copyRemoteUrl', 'copyToAiChat']) assert.ok(menu.includes(c), c);
  for (const c of ['openChangedFile', 'openToSide', 'addTo.claude', 'revealInFinder', 'cut', 'copy', 'rename', 'delete', 'openTimeline']) {
    assert.ok(!menu.includes(c), c);
  }
});

test('a workspace folder row can be copied but not renamed, cut or deleted', () => {
  const menu = menuFor(FILES, 'folder root');
  for (const c of ['newFile', 'copy', 'paste', 'copyPath']) assert.ok(menu.includes(c), c);
  for (const c of ['rename', 'delete', 'cut']) assert.ok(!menu.includes(c), c);
});

test('a folder past the depth limit offers Scan This Folder', () => {
  assert.ok(menuFor(FILES, 'folder unscanned').includes('scanFolder'));
  assert.ok(!menuFor(FILES, 'folder').includes('scanFolder'));
});

test('shortcuts only act when the file tree has focus, outside its find box', () => {
  for (const k of contributes.keybindings) {
    assert.match(k.when, /^focusedView == multiRepoExplorer\.explorer && !inputFocus/, k.command);
  }
});
