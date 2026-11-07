// Runs the integration suite inside a real VS Code, on a workspace made by
// scripts/make-sample-repos.sh:
//
//   npm run test:integration -- <sample-workspace>
//   npm run test:integration -- <sample-workspace> --chat <extensions-dir>
//   npm run test:integration -- <sample-workspace> --multi-root
//
// With --chat, the chat suite runs instead, with the extensions found in
// <extensions-dir> enabled (Claude Code and Codex, typically copied from
// ~/.vscode/extensions). With --multi-root, the multi-root suite runs in a
// workspace of three of the sample's folders, one inside another, and one
// that doesn't exist.
//
// Uses the installed VS Code when VSCODE_PATH is set, otherwise downloads one.
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const [workspace, flag, chatExtensions] = process.argv.slice(2);
  const multiRoot = flag === '--multi-root';
  if (!workspace || (flag && !multiRoot && (flag !== '--chat' || !chatExtensions))) {
    throw new Error('usage: run.js <sample-workspace> [--chat <extensions-dir> | --multi-root]');
  }
  const profile = mkdtempSync(path.join(tmpdir(), 'multi-git-explorer-vscode-'));
  const workspaceFile = path.join(profile, 'sample.code-workspace');
  const sample = path.resolve(workspace);
  writeFileSync(
    workspaceFile,
    // The last folder doesn't exist, as when a workspace outlives one of its folders.
    JSON.stringify({ folders: ['services', 'frontend', 'services/search', 'missing'].map(rel => ({ path: path.join(sample, rel) })) }),
  );
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
    extensionTestsPath: path.resolve(__dirname, chatExtensions ? 'chatSuite' : multiRoot ? 'multiRootSuite' : 'suite'),
    extensionTestsEnv: {
      SAMPLE_WORKSPACE: sample,
      // For scripts/coverage.sh, and to run only some tests.
      ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}),
      ...(process.env.TEST_GREP ? { TEST_GREP: process.env.TEST_GREP } : {}),
    },
    launchArgs: [
      multiRoot ? workspaceFile : sample,
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
