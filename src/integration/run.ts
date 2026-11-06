// Runs the integration suite inside a real VS Code, on a workspace made by
// scripts/make-sample-repos.sh:
//
//   npm run test:integration -- <sample-workspace>
//   npm run test:integration -- <sample-workspace> --chat <extensions-dir>
//
// With --chat, the chat suite runs instead, with the extensions found in
// <extensions-dir> enabled (Claude Code and Codex, typically copied from
// ~/.vscode/extensions).
//
// Uses the installed VS Code when VSCODE_PATH is set, otherwise downloads one.
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const [workspace, flag, chatExtensions] = process.argv.slice(2);
  if (!workspace || (flag && (flag !== '--chat' || !chatExtensions))) {
    throw new Error('usage: run.js <sample-workspace> [--chat <extensions-dir>]');
  }
  const profile = mkdtempSync(path.join(tmpdir(), 'multi-git-explorer-vscode-'));
  // The sample workspace puts one repo 4 levels deep, to test folders past the depth limit.
  // Tests that set the selection themselves would race explorer.autoReveal, and most tests
  // look for folders by name, which explorer.compactFolders would merge, so both start off
  // and the tests of them turn them on.
  mkdirSync(path.join(profile, 'user', 'User'), { recursive: true });
  writeFileSync(
    path.join(profile, 'user', 'User', 'settings.json'),
    JSON.stringify({ 'multiGitExplorer.scanDepth': 3, 'explorer.autoReveal': false, 'explorer.compactFolders': false }),
  );

  await runTests({
    vscodeExecutablePath: process.env.VSCODE_PATH,
    extensionDevelopmentPath: path.resolve(__dirname, '../..'),
    extensionTestsPath: path.resolve(__dirname, chatExtensions ? 'chatSuite' : 'suite'),
    extensionTestsEnv: { SAMPLE_WORKSPACE: path.resolve(workspace) },
    launchArgs: [
      path.resolve(workspace),
      ...(chatExtensions ? [] : ['--disable-extensions']),
      '--disable-workspace-trust',
      `--user-data-dir=${path.join(profile, 'user')}`,
      `--extensions-dir=${chatExtensions ? path.resolve(chatExtensions) : path.join(profile, 'extensions')}`,
    ],
  });
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
