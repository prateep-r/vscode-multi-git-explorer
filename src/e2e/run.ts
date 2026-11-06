// Runs the end-to-end suite: starts a real VS Code with the extension on a
// workspace made by scripts/make-sample-repos.sh, and drives its window the
// way a user would (clicks, right-clicks, keyboard), through the Chrome
// DevTools protocol:
//
//   npm run test:e2e -- <sample-workspace>
//
// Needs an installed VS Code, found at VSCODE_PATH or in its usual place.
// The suite changes files in the workspace, so use a fresh one.
import { spawn, type ChildProcess } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import * as path from 'path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { tests } from './suite';

const DEFAULT_CODE: Record<string, string> = {
  darwin: '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
  win32: path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
  linux: '/usr/share/code/code',
};

/** Settings that make VS Code's menus and dialogs part of the page, so they can be read and clicked. */
const SETTINGS = {
  'window.menuStyle': 'custom',
  'window.titleBarStyle': 'custom',
  'window.dialogStyle': 'custom',
  'workbench.startupEditor': 'none',
  'workbench.tips.enabled': false,
  'files.enableTrash': false,
  'git.openRepositoryInParentFolders': 'never',
  'chat.disableAIFeatures': true,
};

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port'))));
    });
  });
}

async function connect(port: number, child: ChildProcess): Promise<Browser> {
  const started = Date.now();
  for (;;) {
    if (child.exitCode !== null) throw new Error(`VS Code exited with code ${child.exitCode}`);
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch (error) {
      if (Date.now() - started > 60_000) throw error;
      await new Promise(r => setTimeout(r, 500));
    }
  }
}

async function workbench(browser: Browser): Promise<Page> {
  const started = Date.now();
  for (;;) {
    for (const page of browser.contexts().flatMap(c => c.pages())) {
      if (await page.locator('.monaco-workbench').count().catch(() => 0)) return page;
    }
    if (Date.now() - started > 60_000) throw new Error('The VS Code window did not open');
    await new Promise(r => setTimeout(r, 500));
  }
}

async function main(): Promise<void> {
  const workspace = process.argv[2];
  if (!workspace) throw new Error('usage: run.js <sample-workspace>');
  const code = process.env.VSCODE_PATH ?? DEFAULT_CODE[process.platform];
  const profile = mkdtempSync(path.join(tmpdir(), 'multi-git-explorer-e2e-'));
  const shots = path.resolve(__dirname, '..', '..', '.e2e-screenshots');
  rmSync(shots, { recursive: true, force: true });
  mkdirSync(path.join(profile, 'user', 'User'), { recursive: true });
  writeFileSync(path.join(profile, 'user', 'User', 'settings.json'), JSON.stringify(SETTINGS, null, 2));

  const port = await freePort();
  const env = { ...process.env };
  // Set when run from a terminal inside VS Code; it would start Code as plain Node.
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    code,
    [
      path.resolve(workspace),
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${path.join(profile, 'user')}`,
      `--extensions-dir=${path.join(profile, 'extensions')}`,
      `--extensionDevelopmentPath=${path.resolve(__dirname, '..', '..')}`,
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      '--new-window',
    ],
    { env, stdio: 'ignore' },
  );

  let failed = 0;
  let browser: Browser | undefined;
  try {
    browser = await connect(port, child);
    const page = await workbench(browser);
    for (const [name, fn] of tests) {
      try {
        await fn(page, path.resolve(workspace));
        console.log(`  ✔ ${name}`);
      } catch (error) {
        failed++;
        mkdirSync(shots, { recursive: true });
        const file = path.join(shots, `${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`);
        await page.screenshot({ path: file }).catch(() => undefined);
        console.log(`  ✘ ${name}\n    ${error instanceof Error ? error.message.split('\n')[0] : error}\n    screenshot: ${file}`);
        // Leave no menu, dialog or input box open for the next test.
        for (let i = 0; i < 3; i++) await page.keyboard.press('Escape');
      }
    }
  } finally {
    await browser?.close().catch(() => undefined);
    child.kill();
    rmSync(profile, { recursive: true, force: true });
  }
  if (failed) throw new Error(`${failed} of ${tests.length} end-to-end tests failed`);
  console.log(`  ${tests.length} end-to-end tests passed`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
