// Runs the integration suite inside a real VS Code, on a workspace made by
// scripts/make-sample-repos.sh:
//
//   npm run test:integration -- <sample-workspace>
//
// Uses the installed VS Code when VSCODE_PATH is set, otherwise downloads one.
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const workspace = process.argv[2];
  if (!workspace) throw new Error('usage: run.js <sample-workspace>');
  const profile = mkdtempSync(path.join(tmpdir(), 'multi-repo-git-status-vscode-'));

  await runTests({
    vscodeExecutablePath: process.env.VSCODE_PATH,
    extensionDevelopmentPath: path.resolve(__dirname, '../..'),
    extensionTestsPath: path.resolve(__dirname, 'suite'),
    extensionTestsEnv: { SAMPLE_WORKSPACE: path.resolve(workspace) },
    launchArgs: [
      path.resolve(workspace),
      '--disable-extensions',
      '--disable-workspace-trust',
      `--user-data-dir=${path.join(profile, 'user')}`,
      `--extensions-dir=${path.join(profile, 'extensions')}`,
    ],
  });
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
