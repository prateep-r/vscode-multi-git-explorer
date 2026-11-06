# Contributing to Multi-Git Explorer

Needs Node.js 20 or later, git, and an installed VS Code for the tests that run inside it.

```bash
git clone https://github.com/prateep-r/vscode-multi-git-explorer.git
cd vscode-multi-git-explorer
npm install
npm run compile        # or: npm run watch
```

Press <kbd>F5</kbd> in VS Code to run the extension in a new window (the *Extension Development Host*).

Run `make` to list the shortcuts for these and for releasing.

## Build and install from source

```bash
npx @vscode/vsce package -o multi-git-explorer.vsix
code --install-extension multi-git-explorer.vsix --force
```

## Releasing

Write what changed under `## Unreleased` at the top of [CHANGELOG.md](CHANGELOG.md) as you go. To release it, from a clean `main` that's in sync with GitHub:

```bash
make release-patch    # bug fixes:  1.2.0 -> 1.2.1
make release-minor    # features:   1.2.0 -> 1.3.0
make release-major    # breaking:   1.2.0 -> 2.0.0
```

This runs the unit tests, renames `## Unreleased` to the new version, bumps `package.json`, commits `Release x.y.z`, tags `vx.y.z`, and pushes. The tag starts the [Publish workflow](.github/workflows/publish.yml), which publishes to the VS Code Marketplace and creates the GitHub release with `multi-git-explorer.vsix` attached.

The workflow signs in to the Marketplace with [trusted publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#secure-automated-publishing-to-visual-studio-marketplace), so there's no token to keep. It needs a trusted publishing policy on the `prateep-r` publisher (**Manage Publishers & Extensions → Trusted Publishing**) for owner `prateep-r`, repository `vscode-multi-git-explorer`, and workflow `publish.yml`. If the workflow fails, fix the cause and select **Re-run failed jobs** on the run; the tag doesn't need to change unless the code does.

The workflow has three jobs, each with only the permissions it needs: `build` runs `npm ci` and the tests with read-only access, `publish` installs from the lockfile with `--ignore-scripts` and is the only job that can publish, and `release` creates the GitHub release. Actions are pinned to commit SHAs; when updating one, pin the new release's commit and keep the version in the comment.

Keep the file name `multi-git-explorer.vsix` without a version, so the `releases/latest/download/multi-git-explorer.vsix` link in the README's install steps always gets the newest one.

The Marketplace's **Details** tab shows `README.md`, so keep the README about using the extension and put anything for contributors here.

## Tests

There are four kinds, from fastest to closest to real use:

| Kind | Command | What it covers | Time |
| --- | --- | --- | --- |
| Unit | `npm test` | Logic in `src/core/` with no VS Code: parsing `git status`, reading `.git`, discovery, the queue, state and badges, filtering, file names and paths, remote links, and the menus and shortcuts in `package.json` checked against every kind of row | ~2 s |
| Integration | `npm run test:integration -- <workspace>` | The extension inside a real VS Code, through its API: discovery and status of 300 repos, the views, filters, diffs, switching branches, the file watcher, and every right-click command | ~1 min |
| Chat | `npm run test:integration -- <workspace> --chat <extensions>` | Handing files to the real Claude Code and Codex extensions | ~30 s |
| End to end | `npm run test:e2e -- <workspace>` | A real VS Code window driven like a user: clicking, right-clicking and reading the menus, keyboard shortcuts, dialogs, drag and drop, and the filter buttons | ~1 min |

The integration, chat and end-to-end tests run on a sample workspace with repos in every state (conflicts, rebases, detached HEADs, stashes, unpushed and behind branches…). They change files in it, so make a fresh one for each run:

```bash
scripts/make-sample-repos.sh /tmp/sample-ws 300    # 300 repos; the end-to-end tests need only 40
export VSCODE_PATH="/Applications/Visual Studio Code.app/Contents/MacOS/Code"
npm run test:integration -- /tmp/sample-ws

# Chat hand-off, with Claude Code and Codex copied into a separate extensions folder:
mkdir -p /tmp/chat-ext && cp -R ~/.vscode/extensions/{anthropic.claude-code,openai.chatgpt}-* /tmp/chat-ext/
rm -rf /tmp/sample-ws && scripts/make-sample-repos.sh /tmp/sample-ws 300
npm run test:integration -- /tmp/sample-ws --chat /tmp/chat-ext

rm -rf /tmp/e2e-ws && scripts/make-sample-repos.sh /tmp/e2e-ws 40
npm run test:e2e -- /tmp/e2e-ws
```

- Every run uses its own temporary VS Code profile, so your settings and extensions aren't touched. The integration tests set `multiGitExplorer.scanDepth` to 3 there, since the sample workspace has one repo 4 levels deep to test folders past the limit.
- If you run the tests from a terminal inside VS Code (or another Electron app), clear `ELECTRON_RUN_AS_NODE` first: `env -u ELECTRON_RUN_AS_NODE npm run …`.
- The chat and integration tests borrow the system clipboard and put back what was there.
- The end-to-end tests start VS Code with `--remote-debugging-port` and drive it with [Playwright](https://playwright.dev) over the DevTools protocol. They turn on custom (HTML) menus and dialogs in the test profile so they can be read and clicked. `VSCODE_PATH` is optional; the usual install location is used otherwise. When a test fails, a screenshot is saved in `.e2e-screenshots/`.

## README images

The images are drawn as HTML from the sample workspace's real output. After changing how something looks, redraw them all with `assets/images/source/render.sh` (needs Python 3 and Google Chrome).

## Source layout

| Path | Contents |
| --- | --- |
| `src/core/` | Logic with no VS Code dependency, unit-tested: `porcelain.ts` (parsing `git status`), `gitDir.ts` (reading `.git`), `discovery.ts`, `queue.ts`, `state.ts` (which state, badge and text a repo shows), `filter.ts`, `branches.ts`, `paths.ts`, `fileNames.ts`, `remoteLink.ts` and `remoteUrl.ts` (web links), `mention.ts` (`@path` mentions) |
| `src/store.ts` | Keeps every repo's state up to date: discovery, refresh queue, file watching |
| `src/views/` | The Files and Git Repositories views, decorations, status bar, and the read-only `HEAD` documents used for diffs |
| `src/commands.ts` | Git and toolbar commands |
| `src/fileCommands.ts` | New File, Rename, Delete, Cut/Copy/Paste, and drag and drop in the file tree |
| `src/pathCommands.ts` | Reveal, terminal, Find in Folder, Copy Path, compare, Timeline, and links to the remote website |
| `src/chatTargets.ts` | Hand-off to Claude Code and Codex, and Copy to AI Chat |
| `src/workspace.ts` | Helpers shared by the commands: workspace folders, `git.path`, and which rows a command acts on |
| `src/test/` | Unit tests (`node:test`) |
| `src/integration/` | Integration and chat tests, run inside VS Code by `@vscode/test-electron` |
| `src/e2e/` | End-to-end tests, driving a VS Code window with Playwright |
| `scripts/make-sample-repos.sh` | Makes the sample workspace the tests run on |
| `media/` | The Activity Bar icon (shipped with the extension) |
| `assets/images/` | README images and the script that draws them (not shipped) |
