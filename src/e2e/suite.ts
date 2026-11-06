import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import * as path from 'path';
import type { Locator, Page } from 'playwright-core';

type Test = (page: Page, workspace: string) => Promise<void>;
export const tests: [string, Test][] = [];
const test = (name: string, fn: Test) => tests.push([name, fn]);

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';
const DELETE = process.platform === 'darwin' ? 'Meta+Backspace' : 'Delete';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A view in the side bar, by its title. */
function pane(page: Page, title: string): Locator {
  return page.locator('.sidebar .pane').filter({ has: page.locator('.pane-header h3.title', { hasText: new RegExp(`^${title}$`, 'i') }) });
}

/** A row of the Files tree, by its name. */
function row(page: Page, name: string): Locator {
  return pane(page, 'Files')
    .locator('[role=treeitem]')
    .filter({ has: page.locator('.label-name', { hasText: new RegExp(`^${escapeRegExp(name)}$`) }) })
    .first();
}

/** Expands folder rows one after another, like clicking down a path. */
async function expand(page: Page, ...names: string[]): Promise<void> {
  for (const name of names) {
    const r = row(page, name);
    await r.waitFor();
    if ((await r.getAttribute('aria-expanded')) !== 'true') await r.locator('.monaco-tl-twistie').click();
    await assertEventually(`${name} to expand`, async () => (await r.getAttribute('aria-expanded')) === 'true');
  }
}

/**
 * Clicks a row and waits until it's selected and the tree has keyboard focus,
 * so a shortcut pressed next goes to the tree rather than an editor.
 */
async function select(page: Page, name: string): Promise<void> {
  const r = row(page, name);
  await r.click();
  await assertEventually(`${name} to be selected`, async () => (await r.getAttribute('aria-selected')) === 'true');
  const files = pane(page, 'Files');
  await assertEventually('the file tree to have focus', () =>
    files.evaluate(el => el.contains(el.ownerDocument.activeElement)),
  );
  // Let a refresh from a file change finish, since it re-renders the rows.
  await page.waitForTimeout(300);
}

/** The labels of the open context menu, without separators. */
async function menuLabels(page: Page): Promise<string[]> {
  const menu = page.locator('.context-view .monaco-menu').last();
  await menu.waitFor();
  return (await menu.locator('.action-label').allTextContents()).map(s => s.trim()).filter(Boolean);
}

async function rightClick(page: Page, name: string): Promise<string[]> {
  await row(page, name).click({ button: 'right' });
  const labels = await menuLabels(page);
  return labels;
}

async function closeMenu(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.locator('.context-view .monaco-menu').waitFor({ state: 'detached' }).catch(() => undefined);
}

async function assertEventually(what: string, check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 100));
  }
}

/** Clicks a button of the modal dialog showing `message`. */
async function answerDialog(page: Page, message: RegExp, button: string): Promise<void> {
  const dialog = page.locator('.monaco-dialog-box');
  await dialog.waitFor();
  const text = dialog.locator('.dialog-message-text');
  await assertEventually(`a dialog saying ${message}`, async () => message.test(await text.innerText()), 5_000).catch(async error => {
    await page.keyboard.press('Escape');
    throw new Error(`${(error as Error).message}, but it says "${await text.innerText().catch(() => '')}"`);
  });
  await dialog.locator('.monaco-button', { hasText: new RegExp(`^${escapeRegExp(button)}$`) }).click();
  await dialog.waitFor({ state: 'detached' });
}

test('the side bar opens on Multi-Git Explorer, with Files and Git Repositories', async page => {
  const title = page.locator('.sidebar .composite.title h2');
  await assertEventually('the Multi-Git Explorer side bar', async () => /multi-git explorer/i.test((await title.textContent()) ?? ''));
  const views = (await page.locator('.sidebar .pane-header h3.title').allTextContents()).map(s => s.trim());
  assert.deepEqual(views, ['Files', 'Git Repositories']);
});

test('repo rows show their branch and state after the name', async page => {
  await row(page, 'services').waitFor();
  await assertEventually('folder summary', async () => /9 repos/.test(await row(page, 'services').innerText()));
  await expand(page, 'services');
  await assertEventually('branch of auth-service', async () => /⎇ feat\/sso/.test(await row(page, 'auth-service').innerText()));
});

test('right-clicking a repo shows each command once, git commands first', async page => {
  const labels = await rightClick(page, 'auth-service');
  await closeMenu(page);
  const repeated = labels.filter((l, i) => labels.indexOf(l) !== i && l !== 'Copy');
  assert.deepEqual(repeated, [], `repeated menu items: ${repeated.join(', ')}`);
  assert.equal(labels[0], 'Switch Branch...');
  for (const label of ['Fetch', 'Push', 'New File...', 'Find in Folder...', 'Cut', 'Paste', 'Copy Path', 'Copy Remote File URL', 'Rename...', 'Delete']) {
    assert.ok(labels.includes(label), `${label} in the menu`);
  }
  assert.ok(labels.indexOf('Copy Branch Name') < labels.indexOf('New File...'), 'git commands come before file commands');
});

test('right-clicking a file shows file commands but no git commands', async page => {
  await expand(page, 'auth-service');
  const labels = await rightClick(page, 'README.md');
  await closeMenu(page);
  for (const label of ['Open to the Side', 'Select for Compare', 'Open Timeline', 'Copy Relative Path', 'Rename...', 'Delete']) {
    assert.ok(labels.includes(label), `${label} in the menu`);
  }
  for (const label of ['Switch Branch...', 'Fetch', 'Find in Folder...', 'New File...']) {
    assert.ok(!labels.includes(label), `${label} not in the menu`);
  }
});

test('F2 renames a file through an input box', async (page, workspace) => {
  const dir = path.join(workspace, 'docs', 'e2e');
  mkdirSync(path.join(dir, 'sub'), { recursive: true });
  writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  await expand(page, 'docs', 'e2e');
  await select(page, 'a.txt');
  await page.keyboard.press('F2');
  const input = page.locator('.quick-input-widget input.input');
  await input.waitFor();
  assert.equal(await input.inputValue(), 'a.txt');
  await input.fill('b.txt');
  await page.keyboard.press('Enter');
  await assertEventually('b.txt on disk', () => existsSync(path.join(dir, 'b.txt')) && !existsSync(path.join(dir, 'a.txt')));
  await row(page, 'b.txt').waitFor();
});

test('shortcuts follow the focused row: Enter renames on macOS, Space opens keeping focus, Cmd+Down opens', async (page, workspace) => {
  const dir = path.join(workspace, 'docs', 'e2e-keys');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  writeFileSync(path.join(dir, 'b.txt'), 'b\n');
  await expand(page, 'docs', 'e2e-keys');
  await select(page, 'a.txt');
  // Arrow keys move the focus but, in an extension's tree, not the selection.
  await page.keyboard.press('ArrowDown');
  const input = page.locator('.quick-input-widget input.input');
  await page.keyboard.press(process.platform === 'darwin' ? 'Enter' : 'F2');
  await input.waitFor();
  assert.equal(await input.inputValue(), 'b.txt', 'renames the focused row, not the selected one');
  await page.keyboard.press('Escape');
  await input.waitFor({ state: 'hidden' });

  const files = pane(page, 'Files');
  const tab = (name: string) => page.locator('.tabs-container .tab', { hasText: name });
  await select(page, 'a.txt');
  await page.keyboard.press('Space');
  await tab('a.txt').waitFor();
  assert.ok(await files.evaluate(el => el.contains(el.ownerDocument.activeElement)), 'Space keeps focus in the tree');

  await page.keyboard.press('ArrowDown');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Enter');
  await tab('b.txt').waitFor();
  const editors = page.locator('.part.editor');
  await assertEventually('focus to move to the editor', () => editors.evaluate(el => el.contains(el.ownerDocument.activeElement)));
  await page.keyboard.press(`${MOD}+K`);
  await page.keyboard.press('W');
});

test('copy and paste with the keyboard make a copy next to the file', async (page, workspace) => {
  const dir = path.join(workspace, 'docs', 'e2e');
  await select(page, 'b.txt');
  await page.keyboard.press(`${MOD}+C`);
  await page.locator('.statusbar', { hasText: 'Copied b.txt' }).waitFor();
  await page.keyboard.press(`${MOD}+V`);
  await assertEventually('b copy.txt on disk', () => existsSync(path.join(dir, 'b copy.txt')));
  await row(page, 'b copy.txt').waitFor();
});

test('delete with the keyboard asks first', async (page, workspace) => {
  const file = path.join(workspace, 'docs', 'e2e', 'b copy.txt');
  await select(page, 'b copy.txt');
  await page.keyboard.press(DELETE);
  await answerDialog(page, /permanently delete 'b copy\.txt'/, 'Delete');
  await assertEventually('the file to be deleted', () => !existsSync(file));
  await assertEventually('its row to go', async () => (await row(page, 'b copy.txt').count()) === 0);
});

test('dragging a file onto a folder moves it there after asking', async (page, workspace) => {
  const dir = path.join(workspace, 'docs', 'e2e');
  await row(page, 'b.txt').dragTo(row(page, 'sub'));
  await answerDialog(page, /move 'b\.txt' into 'sub'/, 'Move');
  await assertEventually('b.txt in sub', () => existsSync(path.join(dir, 'sub', 'b.txt')) && !existsSync(path.join(dir, 'b.txt')));
});

test('Show Only Changed Files lists only the changed files, and turns off again', async page => {
  const files = pane(page, 'Files');
  await files.hover();
  await files.locator('.actions .action-label[aria-label="Show Only Changed Files"]').click();
  await row(page, 'NOTES.md').waitFor();
  assert.equal(await row(page, 'docs').count(), 0, 'folders without changes are hidden');
  await files.locator('.actions .action-label[aria-label^="Showing Only Changed Files"]').click();
  await row(page, 'docs').waitFor();
});
