# Multi-Repo Git Status

**A VS Code extension that shows the branch and git status of every repository in your workspace — at a glance, even with hundreds of repos.**

If you keep many git repos in one folder (microservices, a polyrepo, a `~/projects` folder…), it's hard to remember which repo is on which branch, which ones have uncommitted work, and which ones you forgot to push. This extension writes all of that next to the folder names, lets you narrow the tree down to what changed, and lets you review, switch branches, or hand files to an AI chat from a right-click.

![Repo Explorer and Git Repos views](assets/images/overview.png)

1. **Explorer** (called *Repo Explorer* in this README, to tell it apart from VS Code's built-in Explorer): your files, with each repo's branch and status written after its name. The project's folder name is shown next to its title.
2. **Git Repos**: every repo, grouped by what needs your attention. Problems are listed first.
3. **Status bar**: the branch of the repo you're editing in (left) and totals for all repos (right).

## Contents

- [Quick start](#quick-start)
- [Features](#features)
  - [See every repo's branch and status](#see-every-repos-branch-and-status)
  - [Show only what changed](#show-only-what-changed)
  - [Review a change](#review-a-change)
  - [Switch branches](#switch-branches)
  - [Right-click menus](#right-click-menus)
  - [Send files to Claude Code or Codex](#send-files-to-claude-code-or-codex)
  - [Badges in the built-in Explorer (optional)](#badges-in-the-built-in-explorer-optional)
  - [Light and dark themes](#light-and-dark-themes)
- [What the symbols mean](#what-the-symbols-mean)
- [Install](#install)
- [Settings](#settings)
- [What it does to your repos](#what-it-does-to-your-repos)
- [Performance](#performance)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)
- [Development](#development)

## Quick start

1. [Install the extension](#install).
2. Open the folder that holds your repos (**File → Open Folder…**).
3. Click the **Multi-Repo Git Status** icon (a radar) in the Activity Bar.

Repos are found automatically, up to 3 folder levels deep. Every repo shows its branch right away; the rest of its status fills in within a few seconds.

## Features

### See every repo's branch and status

- **Repo Explorer** works like the normal Explorer: expand folders and click files to open them. Each repo shows its branch and status after its name. Folders that contain repos show a summary like `9 repos · !2 ●2 ↑2 ↓2`, so you can tell what's inside without expanding them. Changed files carry the same letters as Source Control (`M`, `A`, `U`…).
- **Git Repos** lists every repo, grouped: *Conflict / in progress*, *Uncommitted changes*, *Not pushed*, *Behind remote*, *Clean*. Use the filter icon in its title bar to find a repo by path or branch name. Hover a row for buttons to open it in Source Control or in a terminal.
- **Status bar**: the left item shows the branch of the file you're editing; click it to open that repo in Source Control. The right item counts repos by state; click it to jump to Git Repos.
- **Tooltips**: hover a repo for the full picture — upstream, ahead/behind, changed files, stashes, and when it was last fetched.

### Show only what changed

The **Repo Explorer** title bar has three filter buttons. Click one to turn it on, and click it again to turn it off. The icon is filled while it's on. You can turn on more than one, and repos matching any of them are shown.

| Button | Off | On | Shows |
| --- | --- | --- | --- |
| Changed files | ○ | ● | Repos with uncommitted or conflicted files, listing only those files and the folders they're in |
| Not pushed | ↑ | ⬆︎ in a circle | Repos with commits that aren't pushed yet |
| Behind remote | ↓ | ⬇︎ in a circle | Repos with new commits on the remote (as of the last fetch) |

![Repo Explorer filtered to changed files](assets/images/filter.png)

Changed files get the same letters as VS Code's Source Control: `M` modified, `A` added, `D` deleted, `R` renamed, `U` untracked, `!` conflict. Next to the letter you may see `staged`, `partly staged`, or `conflict`. The filter is remembered per workspace.

To search files by name or content, use VS Code's own **Search** view (<kbd>Cmd</kbd>/<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd>). Put a repo's path in *files to include* to search just that repo.

### Review a change

With **Changed files** on, **click a file to review it.** It opens a diff of the last commit (`HEAD`) against your working copy, so you see staged and unstaged changes together.

![Diff of a changed file, opened from the Repo Explorer](assets/images/diff.png)

- Added lines are green and removed lines are red. Within a changed line, the exact part that changed is highlighted.
- New files show as fully added and deleted files as fully removed. Renamed files are compared with their old name.
- Files with conflicts open as normal files, so you can resolve them.
- The diff opens as a preview tab, so clicking the next file replaces it instead of piling up tabs.
- To edit the file, use the **Open File** button on its row.
- To review every changed file of a repo in one tab, right-click the repo and choose **View All Changes**.

### Switch branches

Right-click a repo and choose **Switch Branch…** (the first item in the menu).

![Branch picker](assets/images/switch-branch.png)

- **Local branches** are listed newest first, with how far each is ahead of or behind its upstream, and whether the upstream was deleted.
- **Remote branches** you haven't checked out yet are listed after them. Picking one creates a local branch that tracks it.
- **Create new branch…** starts a branch from where you are; **Create new branch from…** lets you pick another branch to start from. Names are checked against git's rules as you type.
- **Uncommitted changes** come along to the new branch when git allows it. If they would be overwritten, you're asked whether to **Stash and Switch**; your changes are kept in a stash that you can bring back with `git stash pop`.
- Switching is refused while a merge or rebase is in progress, so you finish or abort it first.

### Right-click menus

![Right-click menu on a repo](assets/images/menu.png)

On a **repo**:

| Command | What it does |
| --- | --- |
| Switch Branch… | Picks a branch to switch to, or creates one ([details](#switch-branches)) |
| Copy to Claude Chat / Copy to Codex Chat | Copies `@path/` for the chat ([details](#send-files-to-claude-code-or-codex)) |
| Open in Source Control | Opens the repo in VS Code's Git and shows the Source Control view |
| View All Changes | Opens every changed file of the repo in one diff view |
| Fetch / Pull / Push | Runs the git command for this repo. Push sets an upstream if the branch has none |
| Open Terminal Here | Opens a terminal in the repo folder |
| Open Repo in New Window | Opens just this repo in a new VS Code window |
| Copy Branch Name | Copies the current branch name |

Fetch shows only for repos with a remote, Pull only for branches with an upstream, and Push only when there is something to push.

On a **file**: **Add to Claude Chat** / **Add to Codex Chat**, and for changed files **Open Changes** and **Open File**.

On a **folder**: **Copy to Claude Chat** / **Copy to Codex Chat**, and **Scan This Folder** for folders deeper than the scan limit.

The title bar of **Git Repos** has **Fetch All Repos**, **Filter Repos**, and **Refresh**. All of these are also in the Command Palette under *Multi-Repo Git Status*.

### Send files to Claude Code or Codex

If you have [Claude Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) or [Codex](https://marketplace.visualstudio.com/items?itemName=openai.chatgpt) installed, right-click in the Repo Explorer to hand files to its chat. Select several rows first (<kbd>Cmd</kbd>/<kbd>Ctrl</kbd>+click or <kbd>Shift</kbd>+click) to send them all at once. Together with the **Changed files** button, this makes it quick to ask for a review of what you're about to push.

![Adding changed files to the chat](assets/images/chat.png)

| Right-click on | Menu | What happens |
| --- | --- | --- |
| A file | **Add to Claude Chat** / **Add to Codex Chat** | The file is added to the chat's message box |
| A folder or repo | **Copy to Claude Chat** / **Copy to Codex Chat** | `@path/` is copied and the chat is opened. Paste it with <kbd>Cmd</kbd>/<kbd>Ctrl</kbd>+<kbd>V</kbd> |

- Nothing is sent until you press <kbd>Enter</kbd> in the chat.
- Folders are copied rather than added because neither extension offers a way to add a folder for you.
- Each menu item only appears when that extension is installed.
- Claude Code can only mention the file open in the editor, so **Add to Claude Chat** briefly opens each file in a preview tab first. If a chat extension refuses a file, its `@path` is copied instead.

Tested with Claude Code 2.1.318 and Codex 26.1021. Both extensions decide how they show what they receive, so this may change as they update.

### Badges in the built-in Explorer (optional)

The built-in Explorer is left unchanged by default. Turn on `multiRepoGit.decorateExplorer` to also give repo folders there a color, a short badge, a tooltip, and a **Git Repo** right-click menu with the repo commands above.

![Badges and tooltip in the built-in Explorer](assets/images/explorer.png)

> VS Code lets extensions show only a color and a badge of up to two characters in the built-in Explorer. To see branch names next to folders, use **Repo Explorer**.

### Light and dark themes

Colors come from your theme. Changed files use the theme's own git colors (the same as the built-in Explorer and Source Control), and repo states use colors with separate light, dark, and high-contrast values. The screenshots above use *Dark Modern*; here is the same workspace with *Light Modern*:

![Repo Explorer and Git Repos with a light theme](assets/images/overview-light.png)

![Reviewing a change with a light theme](assets/images/diff-light.png)

To change any of these colors, see [Settings](#settings).

## What the symbols mean

| Badge | Color | Meaning |
| --- | --- | --- |
| *(none)* | normal | Clean and in sync with its upstream |
| `4`, `9+` | yellow | Files with uncommitted changes |
| `↑2` | blue | 2 commits not pushed yet |
| `↑` | blue | The branch has never been pushed (no upstream) |
| `↓4` | purple | 4 commits behind the remote, as of the last fetch |
| `↕` | purple | Diverged: commits to push *and* to pull |
| `!` | red | Files with merge conflicts |
| `M` `R` `C` `V` | red | Merge, rebase, cherry-pick or revert in progress |
| `D` | yellow | Detached HEAD (not on a branch) |
| `…` | gray | Still checking |
| `⚠` | red | The status could not be read. Hover for the error |

When a repo has several states at once, the badge shows the most important one. The text after the name shows all of them:

| Text | Meaning |
| --- | --- |
| `⎇ main` | Current branch |
| `●2` | 2 files modified |
| `+1` | 1 file staged |
| `?1` | 1 untracked file |
| `✕1` | 1 file with conflicts |
| `↑2 ↓3` | 2 commits to push, 3 to pull |
| `≡1` | 1 stash entry |
| `MERGING`, `REBASING 1/2` | An operation is in progress (rebase step 1 of 2) |
| `no upstream` | The branch has never been pushed |
| `submodule` | The repo is a submodule of the repo around it |

Folders that aren't repos show `no git` (no repos inside), `not scanned` (deeper than the scan limit; right-click and choose **Scan This Folder**), or `excluded`. Local-only repos without a remote are never flagged as unpushed.

## Install

The extension isn't on the VS Code Marketplace yet. Build it from source:

```bash
git clone https://github.com/prateep-r/vscode-multi-repo-git-status.git
cd vscode-multi-repo-git-status
npm install
npx @vscode/vsce package
code --install-extension multi-repo-git-status-0.0.1.vsix
```

Then run **Developer: Reload Window** in VS Code.

Requirements: VS Code 1.95 or later, Node.js 20 or later (to build), and `git` on your `PATH` (or set in `git.path`).

To update, pull the latest code, build again, and install with `--force`. To uninstall:

```bash
code --uninstall-extension local.multi-repo-git-status
```

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `multiRepoGit.scanDepth` | `3` | How many folder levels below each workspace folder to search for repos |
| `multiRepoGit.exclude` | `node_modules`, `vendor`, `dist`, `build`, `out`, `target`, … | Folder names that are never searched |
| `multiRepoGit.decorateExplorer` | `false` | Also show repo colors, badges, and the **Git Repo** menu in the built-in Explorer |
| `multiRepoGit.maxConcurrency` | `6` | Maximum number of git processes at the same time |
| `multiRepoGit.countUntracked` | `true` | Count untracked files. Turn off for faster checks in very large repos |
| `multiRepoGit.refreshOnFocus` | `true` | Re-check repos when the VS Code window gets focus |
| `multiRepoGit.backgroundRefreshMinutes` | `5` | Re-check all repos this often. `0` turns it off |

You can change the colors with `workbench.colorCustomizations`:

```jsonc
"workbench.colorCustomizations": {
  "multiRepoGit.aheadForeground": "#4FC1FF",
  "multiRepoGit.behindForeground": "#D18AE0"
}
```

Available colors: `multiRepoGit.conflictForeground`, `multiRepoGit.dirtyForeground`, `multiRepoGit.aheadForeground`, `multiRepoGit.behindForeground`, `multiRepoGit.pendingForeground`, `multiRepoGit.errorForeground`.

## What it does to your repos

Showing status only **reads** your repos. It never changes files, branches, or the index, and it never takes git's `index.lock`, so it can't get in the way of your own git commands.

Your repos are changed only when you ask, with these commands: **Switch Branch…** (and **Stash and Switch** when you confirm it), **Fetch**, **Pull**, **Push**, and **Fetch All Repos**. Nothing is fetched or pushed in the background.

## Performance

Tested with 300 repos: they are found in about 50 ms, every repo shows its branch right away, and all statuses are checked in about 4 seconds in the background.

- **Branch and in-progress state** (merge, rebase…) are read directly from files in `.git`, without running git.
- **`git status`** runs through a queue, a few at a time. Repos you're working in go first, then repos on screen, then the rest.
- **Changes are picked up automatically**, including commits made in a terminal outside VS Code. The extension uses VS Code's own file watcher and debounces changes per repo.
- **Nothing is fetched automatically.** "Behind remote" is based on your last fetch. Use **Fetch All Repos** to update it.

## Troubleshooting

| Problem | What to try |
| --- | --- |
| A repo is missing | It may be deeper than `multiRepoGit.scanDepth`: look for `not scanned` on a folder above it and choose **Scan This Folder**, or raise the setting. Also check that its folder isn't in `multiRepoGit.exclude` |
| A repo shows `⚠` | Hover it to see git's error. Open **View → Output** and pick *Multi-Repo Git Status* for the full log |
| Checking is slow | Turn off `multiRepoGit.countUntracked`, or add big generated folders to `multiRepoGit.exclude` |
| "Behind remote" looks wrong | It's based on your last fetch. Run **Fetch All Repos** |
| Fetch or Push fails asking for a password | Commands run without a terminal, so set up a git credential helper or SSH key |
| No **Add to Claude Chat** / **Add to Codex Chat** | Install that extension, then reload the window |

The Output log also shows how many repos were found and how long it took.

## Known limitations

- **Open in Source Control** shows the Source Control view but can't select the repo for you. VS Code has no API for that. Use **Open Repo in New Window** to get a Source Control view with only that repo.
- The branch name can't be made clickable in the tree; use the right-click menu.
- A repo nested inside another repo is only found if it's a submodule, or if the outer repo is itself a workspace folder.
- Binary files open in the diff as text.
- Only local folders are supported (not Remote SSH, WSL, or virtual workspaces).

## Development

```bash
npm install
npm test                                          # unit tests
scripts/make-sample-repos.sh /tmp/sample-ws 300   # sample workspace with repos in every state
export VSCODE_PATH="/Applications/Visual Studio Code.app/Contents/MacOS/Code"
npm run test:integration -- /tmp/sample-ws        # tests inside a real VS Code

# Chat hand-off, with Claude Code and Codex copied into a separate extensions folder:
mkdir -p /tmp/chat-ext && cp -R ~/.vscode/extensions/{anthropic.claude-code,openai.chatgpt}-* /tmp/chat-ext/
npm run test:integration -- /tmp/sample-ws --chat /tmp/chat-ext
```

If you run the integration tests from a terminal inside VS Code (or another Electron app), clear `ELECTRON_RUN_AS_NODE` first (`env -u ELECTRON_RUN_AS_NODE npm run …`). The chat tests borrow the system clipboard and put back what was there.

Press <kbd>F5</kbd> in VS Code to run the extension in a new window.

The README images are drawn from the sample workspace's real output. After changing how something looks, redraw them all with `assets/images/source/render.sh` (needs Python 3 and Google Chrome).

| Path | Contents |
| --- | --- |
| `src/core/` | Logic with no VS Code dependency: parsing `git status`, reading `.git`, discovery, the job queue, branches, filtering, and the rules for which state and badge to show |
| `src/store.ts` | Keeps every repo's state up to date: discovery, refresh queue, file watching |
| `src/views/` | Repo Explorer, Git Repos view, decorations, status bar, and the read-only `HEAD` documents used for diffs |
| `src/commands.ts` | Right-click and toolbar commands |
| `src/chatTargets.ts` | Hand-off to Claude Code and Codex |
| `src/test/`, `src/integration/` | Unit tests, and tests that run inside VS Code |
| `media/` | The Activity Bar icon (shipped with the extension) |
| `assets/images/` | README images and the script that draws them (not shipped) |

## License

[MIT](LICENSE)
