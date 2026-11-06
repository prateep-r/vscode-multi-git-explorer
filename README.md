# Multi-Repo Explorer

**A VS Code extension that shows the branch and git status of every repository in your workspace — at a glance, even with hundreds of repos.**

If you keep many git repos in one folder (microservices, a polyrepo, a `~/projects` folder…), it's hard to remember which repo is on which branch, which ones have uncommitted work, and which ones you forgot to push. This extension writes all of that next to the folder names, lets you narrow the tree down to what changed, and lets you review, switch branches, or hand files to an AI chat from a right-click.

![Files and Git Repositories views](assets/images/overview.png)

1. **Files**: your files, with each repo's branch and status written after its name, and your project's folder name beside the title.
2. **Git Repositories**: every repo, grouped by what needs your attention. Problems are listed first.
3. **Status bar**: the branch of the repo you're editing in (left) and totals for all repos (right).

## Contents

- [Quick start](#quick-start)
- [Features](#features)
  - [See every repo's branch and status](#see-every-repos-branch-and-status)
  - [Show only what changed](#show-only-what-changed)
  - [Review a change](#review-a-change)
  - [Switch branches](#switch-branches)
  - [Right-click menus](#right-click-menus)
  - [Keyboard shortcuts](#keyboard-shortcuts)
  - [Send files to an AI chat](#send-files-to-an-ai-chat)
  - [Badges in the built-in Explorer (optional)](#badges-in-the-built-in-explorer-optional)
  - [Light and dark themes](#light-and-dark-themes)
- [What the symbols mean](#what-the-symbols-mean)
- [Install](#install)
- [Settings](#settings)
- [What it changes](#what-it-changes)
- [Performance](#performance)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)
- [Development](#development)

## Quick start

1. [Install the extension](#install).
2. Open the folder that holds your repos (**File → Open Folder…**).
3. Click the **Multi-Repo Explorer** icon (two pages with an M) in the Activity Bar. It opens by itself the next time you open the window.

Repos are found automatically, up to 10 folder levels deep. Every repo shows its branch right away; the rest of its status fills in within a few seconds.

## Features

### See every repo's branch and status

- **Files** works like the built-in Explorer: expand folders, click files to open them, and use **New File** / **New Folder** in its title bar (or right-click a folder) to add items. The right-click menu has the built-in Explorer's commands too, such as Rename, Delete, Cut/Copy/Paste and Copy Path, and you can drag items into another folder ([details](#right-click-menus)). Type a path such as `src/utils/date.ts` to create the folders on the way. Each repo shows its branch and status after its name. Folders that contain repos show a summary like `9 repos · !2 ●2 ↑2 ↓2`, so you can tell what's inside without expanding them. Changed files carry the same letters as Source Control (`M`, `A`, `U`…).
- **Git Repositories** lists every repo, grouped: *Conflict / in progress*, *Uncommitted changes*, *Not pushed*, *Behind remote*, *Clean*. Use the filter icon in its title bar to find a repo by path or branch name. Hover a row for buttons to open it in Source Control or in a terminal.
- **Status bar**: the left item shows the branch of the file you're editing; click it to open that repo in Source Control. The right item counts repos by state; click it to jump to Git Repositories.
- **Tooltips**: hover a repo for the full picture — upstream, ahead/behind, changed files, stashes, and when it was last fetched.

### Show only what changed

The title bar of the file tree (the one with your project's name) has three filter buttons. Click one to turn it on, and click it again to turn it off. The icon is filled while it's on. You can turn on more than one, and repos matching any of them are shown.

| Button | Off | On | Shows |
| --- | --- | --- | --- |
| Changed files | ○ | ● | Repos with uncommitted or conflicted files, listing only those files and the folders they're in |
| Not pushed | ↑ | ⬆︎ in a circle | Repos with commits that aren't pushed yet |
| Behind remote | ↓ | ⬇︎ in a circle | Repos with new commits on the remote (as of the last fetch) |

![The file tree filtered to changed files](assets/images/filter.png)

Changed files get the same letters as VS Code's Source Control: `M` modified, `A` added, `D` deleted, `R` renamed, `U` untracked, `!` conflict. Next to the letter you may see `staged`, `partly staged`, or `conflict`. Folders named in `multiRepoExplorer.exclude` and anything hidden by `files.exclude` stay hidden while filtering, even if git sees changes in them. The filter is remembered per workspace.

To search files by name or content, right-click a folder or repo and choose **Find in Folder…**. It opens VS Code's **Search** view limited to that folder.

### Review a change

With **Changed files** on, **click a file to review it.** It opens a diff of the last commit (`HEAD`) against your working copy, so you see staged and unstaged changes together.

![Diff of a changed file, opened from the file tree](assets/images/diff.png)

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

Right-clicking in **Files** shows the commands of the built-in Explorer, and git commands on repos. Select several rows first (<kbd>Cmd</kbd>/<kbd>Ctrl</kbd>+click or <kbd>Shift</kbd>+click) to act on them all at once.

On a **repo**, these come first:

| Command | What it does |
| --- | --- |
| Switch Branch… | Picks a branch to switch to, or creates one ([details](#switch-branches)) |
| Open in Source Control | Opens the repo in VS Code's Git and shows the Source Control view |
| View All Changes | Opens every changed file of the repo in one diff view |
| Fetch / Pull / Push | Runs the git command for this repo. Push sets an upstream if the branch has none |
| Open Repo in New Window | Opens just this repo in a new VS Code window |
| Copy Branch Name | Copies the current branch name |

Fetch shows only for repos with a remote, Pull only for branches with an upstream, and Push only when there is something to push.

On **any file, folder or repo**, like the built-in Explorer:

| Command | Shows on | What it does |
| --- | --- | --- |
| Open Changes / Open File | Changed files | Opens the diff against `HEAD`, or the file itself |
| Open to the Side | Files | Opens the file in an editor beside the current one |
| Add to Claude Chat / Add to Codex Chat | Files | Adds the files to that chat ([details](#send-files-to-an-ai-chat)) |
| Copy to AI Chat | Everything | Copies `@path` mentions to paste into any AI chat |
| New File… / New Folder… | Folders, repos | Creates an item. A path like `src/utils/date.ts` creates the folders on the way |
| Reveal in Finder | Everything | Shows the item in Finder. Called *Reveal in File Explorer* on Windows and *Open Containing Folder* on Linux |
| Open in Integrated Terminal | Everything | Opens a terminal in the folder, or in the folder a file is in |
| Reveal in Explorer View | Everything | Selects the same item in the built-in Explorer, for menus of other extensions that only appear there |
| Find in Folder… | Folders, repos | Opens the Search view limited to the folder |
| Select for Compare, then Compare with Selected | Files | Shows the differences between two files. With two files selected, use **Compare Selected** |
| Open Timeline | Files | Opens the file and shows its history (commits and local saves) in the Timeline view |
| Cut / Copy / Paste | Everything | Moves or copies items into another folder. Pasting where the name is taken makes `name copy.ext`; moving onto a taken name asks before replacing it |
| Copy Path / Copy Relative Path | Everything | Copies the full path, or the path from the project folder. Several rows are copied one per line |
| Copy Remote File URL / Open on Remote (Web) | Rows in a repo with a remote | Copies or opens the link to the item on its website ([details](#links-to-the-remote-website)) |
| Rename… | Everything but workspace folders | Renames the item in an input box, with the name selected without its extension. Open editors follow it, and languages such as TypeScript update imports |
| Delete | Everything but workspace folders | Moves the items to the Trash after asking ([details](#what-it-changes)) |

Rows of deleted files, shown while **Changed files** is on, only get the commands that don't need the file: Open Changes, Copy Path, Copy Relative Path, the remote links and Copy to AI Chat.

Drag items onto a folder to move them there. You're asked first unless `explorer.confirmDragAndDrop` is off. Moving or renaming changes files the same way as the built-in Explorer, so editors and imports follow along.

On a **folder** deeper than the scan limit there is also **Scan This Folder**; expanding the folder does the same.

The title bar of **Git Repositories** has **Fetch All Repos**, **Filter Repos**, and **Refresh**. Git Repositories rows have the repo commands above, plus **Open Terminal Here** and **Copy to AI Chat**. The commands are also in the Command Palette under *Multi-Repo Explorer*.

> Other extensions add their own items (such as *New Java File* or *Run Tests*) only to the built-in Explorer's menu, and VS Code doesn't let them appear here. Use **Reveal in Explorer View** to get to them.

#### Links to the remote website

**Copy Remote File URL** and **Open on Remote (Web)** link to the branch's upstream, so the link shows what you last pushed. A branch that was never pushed links to the remote's default branch instead, and a detached HEAD links to its commit.

The kind of site is guessed from the host name: `github`, `bitbucket.org`, `dev.azure.com`, Bitbucket Server's `/scm/` paths, and Gitea or Codeberg. Other self-hosted sites are treated as GitLab. If yours is different, such as GitHub Enterprise on its own domain, set it in `multiRepoExplorer.remoteHosts`:

```jsonc
"multiRepoExplorer.remoteHosts": {
  "git.mycompany.com": "github"   // github, gitlab, bitbucket, bitbucket-server, azure or gitea
}
```

### Keyboard shortcuts

These work when the **Files** tree has focus: click a row first. Clicking a file opens it as a preview and keeps focus in the tree, like the built-in Explorer, so the shortcuts act on the row rather than the editor.

| Command | Mac | Windows / Linux |
| --- | --- | --- |
| Open to the Side | <kbd>Cmd</kbd>+<kbd>Enter</kbd> | <kbd>Ctrl</kbd>+<kbd>Enter</kbd> |
| Rename… | <kbd>F2</kbd> | <kbd>F2</kbd> |
| Delete | <kbd>Cmd</kbd>+<kbd>Backspace</kbd> | <kbd>Delete</kbd> |
| Cut / Copy / Paste | <kbd>Cmd</kbd>+<kbd>X</kbd> / <kbd>C</kbd> / <kbd>V</kbd> | <kbd>Ctrl</kbd>+<kbd>X</kbd> / <kbd>C</kbd> / <kbd>V</kbd> |
| Copy Path | <kbd>Alt</kbd>+<kbd>Cmd</kbd>+<kbd>C</kbd> | <kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>C</kbd> |
| Copy Relative Path | <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>Cmd</kbd>+<kbd>C</kbd> | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>C</kbd> |
| Reveal in Finder / File Explorer / containing folder | <kbd>Alt</kbd>+<kbd>Cmd</kbd>+<kbd>R</kbd> | <kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>R</kbd> (Windows), <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>R</kbd> (Linux) |
| Find in Folder… | <kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>F</kbd> | <kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>F</kbd> |

With several rows selected, the shortcuts act on all of them, except Rename, which renames one. They don't fire while you type in the tree's find box. Change them under **Preferences → Keyboard Shortcuts** by searching for *Multi-Repo Explorer*.

### Send files to an AI chat

Right-click in **Files** to hand files to an AI chat. Select several rows first to send them all at once. Together with the **Changed files** button, this makes it quick to ask for a review of what you're about to push.

![Adding changed files to the chat](assets/images/chat.png)

| Right-click on | Menu | What happens |
| --- | --- | --- |
| A file | **Add to Claude Chat** / **Add to Codex Chat** | The file is added to the chat's message box. Shows when [Claude Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) or [Codex](https://marketplace.visualstudio.com/items?itemName=openai.chatgpt) is installed |
| Anything | **Copy to AI Chat** | Copies `@path` mentions, such as `@src/utils/ @README.md`, to paste with <kbd>Cmd</kbd>/<kbd>Ctrl</kbd>+<kbd>V</kbd>. If Claude Code or Codex is the only chat installed, it's opened for you |

- Nothing is sent until you press <kbd>Enter</kbd> in the chat.
- `@path` mentions work in Claude Code, Codex, Cursor, Windsurf and Gemini. GitHub Copilot Chat uses `#file:` instead, so it doesn't pick them up.
- Folders are copied rather than added because neither extension offers a way to add a folder for you.
- Claude Code can only mention the file open in the editor, so **Add to Claude Chat** briefly opens each file in a preview tab first. If a chat extension refuses a file, its `@path` is copied instead.

Tested with Claude Code 2.1.318 and Codex 26.1021. Both extensions decide how they show what they receive, so this may change as they update.

### Badges in the built-in Explorer (optional)

The built-in Explorer is left unchanged by default. Turn on `multiRepoExplorer.decorateExplorer` to also give repo folders there a color, a short badge, a tooltip, and a **Git Repo** right-click menu with the repo commands above.

![Badges and tooltip in the built-in Explorer](assets/images/explorer.png)

> VS Code lets extensions show only a color and a badge of up to two characters in the built-in Explorer. To see branch names next to folders, use **Multi-Repo Explorer**.

### Light and dark themes

Colors come from your theme. Changed files use the theme's own git colors (the same as the built-in Explorer and Source Control), and repo states use colors with separate light, dark, and high-contrast values. The screenshots above use *Dark Modern*; here is the same workspace with *Light Modern*:

![Files and Git Repositories with a light theme](assets/images/overview-light.png)

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

Folders that aren't repos show `no git` (no repos inside), `not scanned` (deeper than the scan limit; expand it, or right-click and choose **Scan This Folder**, to search it), or `excluded`. Local-only repos without a remote are never flagged as unpushed.

## Install

The extension is published on [GitHub Releases](https://github.com/prateep-r/vscode-multi-repo-explorer/releases), not on the VS Code Marketplace. Download and install the latest version with one command:

**macOS / Linux**

```bash
curl -fsSL -o /tmp/multi-repo-explorer.vsix https://github.com/prateep-r/vscode-multi-repo-explorer/releases/latest/download/multi-repo-explorer.vsix && code --install-extension /tmp/multi-repo-explorer.vsix --force
```

**Windows (PowerShell)**

```powershell
iwr https://github.com/prateep-r/vscode-multi-repo-explorer/releases/latest/download/multi-repo-explorer.vsix -OutFile $env:TEMP\multi-repo-explorer.vsix; code --install-extension $env:TEMP\multi-repo-explorer.vsix --force
```

Then run **Developer: Reload Window** in VS Code.

Or do it by hand: download [`multi-repo-explorer.vsix`](https://github.com/prateep-r/vscode-multi-repo-explorer/releases/latest/download/multi-repo-explorer.vsix), then in VS Code open the Command Palette and run **Extensions: Install from VSIX…**. It also works in Cursor, Windsurf, and VSCodium: use `cursor`, `windsurf`, or `codium` in place of `code` in the commands above.

Requirements: VS Code 1.95 or later, and `git` on your `PATH` (or set in `git.path`).

**Updating**: the extension doesn't update itself. Run the same command again to get the latest version. See what changed in the [changelog](CHANGELOG.md).

**Uninstalling**:

```bash
code --uninstall-extension prateep-r.multi-repo-explorer
```

If you built a version before 1.0.0 from source, its ID is `local.multi-repo-explorer`. Uninstall that one first, so you don't get two Multi-Repo Explorers. Its settings started with `multiRepoGit.`; they are now `multiRepoExplorer.`, so rename any you changed.

### Build from source

Needs Node.js 20 or later.

```bash
git clone https://github.com/prateep-r/vscode-multi-repo-explorer.git
cd vscode-multi-repo-explorer
npm install
npx @vscode/vsce package -o multi-repo-explorer.vsix
code --install-extension multi-repo-explorer.vsix --force
```

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `multiRepoExplorer.scanDepth` | `10` | How many folder levels below each workspace folder to search for repos. There is no upper limit, so raise it if your repos are deeper |
| `multiRepoExplorer.exclude` | `node_modules`, `vendor`, `dist`, `build`, `out`, `target`, … | Folder names that are never searched, and are hidden while filtering |
| `multiRepoExplorer.decorateExplorer` | `false` | Also show repo colors, badges, and the **Git Repo** menu in the built-in Explorer |
| `multiRepoExplorer.showOnStartup` | `true` | Show the Multi-Repo Explorer in the side bar when a window with a folder opens, instead of the built-in Explorer |
| `multiRepoExplorer.remoteHosts` | `{}` | The kind of website of each git host, for remote links ([details](#links-to-the-remote-website)) |
| `multiRepoExplorer.maxConcurrency` | `6` | Maximum number of git processes at the same time |
| `multiRepoExplorer.countUntracked` | `true` | Count untracked files. Turn off for faster checks in very large repos |
| `multiRepoExplorer.refreshOnFocus` | `true` | Re-check repos when the VS Code window gets focus |
| `multiRepoExplorer.backgroundRefreshMinutes` | `5` | Re-check all repos this often. `0` turns it off |

You can change the colors with `workbench.colorCustomizations`:

```jsonc
"workbench.colorCustomizations": {
  "multiRepoExplorer.aheadForeground": "#4FC1FF",
  "multiRepoExplorer.behindForeground": "#D18AE0"
}
```

Available colors: `multiRepoExplorer.conflictForeground`, `multiRepoExplorer.dirtyForeground`, `multiRepoExplorer.aheadForeground`, `multiRepoExplorer.behindForeground`, `multiRepoExplorer.pendingForeground`, `multiRepoExplorer.errorForeground`.

## What it changes

Showing status only **reads** your repos. It never changes files, branches, or the index, and it never takes git's `index.lock`, so it can't get in the way of your own git commands. Nothing is fetched or pushed in the background.

Things change only when you ask:

| What | Commands | Safeguards |
| --- | --- | --- |
| Branches | **Switch Branch…**, and **Stash and Switch** when you confirm it | Refused during a merge or rebase. Uncommitted changes that would be overwritten are stashed only if you agree |
| Remotes | **Fetch**, **Pull**, **Push**, **Fetch All Repos** | Push sets an upstream only for a branch that has none |
| Files | **New File/Folder**, **Rename**, **Paste**, drag and drop, **Delete** | Taken names are refused, or a copy name is picked; moving onto a taken name asks first. Dragging asks first unless `explorer.confirmDragAndDrop` is off |

**Delete** follows the built-in Explorer's settings. With `files.enableTrash` on (the default), items go to the Trash (the Recycle Bin on Windows), and you're asked first unless `explorer.confirmDelete` is off. With it off, they're deleted for good and you're always asked. A workspace folder can't be renamed, moved or deleted from the tree.

Moving and renaming go through VS Code the same way as in the built-in Explorer, so open editors follow the file, and extensions such as TypeScript can update the imports that point to it. When a folder is moved, copied or deleted, repos are looked for again, since it may have held one.

## Performance

Tested with 300 repos: they are found in about 50 ms, every repo shows its branch right away, and all statuses are checked in about 4 seconds in the background.

- **Branch and in-progress state** (merge, rebase…) are read directly from files in `.git`, without running git.
- **`git status`** runs through a queue, a few at a time. Repos you're working in go first, then repos on screen, then the rest.
- **Changes are picked up automatically**, including commits made in a terminal outside VS Code. The extension uses VS Code's own file watcher and debounces changes per repo.
- **Nothing is fetched automatically.** "Behind remote" is based on your last fetch. Use **Fetch All Repos** to update it.

## Troubleshooting

| Problem | What to try |
| --- | --- |
| A repo is missing | It may be deeper than `multiRepoExplorer.scanDepth`: look for `not scanned` on a folder above it and expand it (or choose **Scan This Folder**), or raise the setting. Also check that its folder isn't in `multiRepoExplorer.exclude` |
| A repo shows `⚠` | Hover it to see git's error. Open **View → Output** and pick *Multi-Repo Explorer* for the full log |
| Checking is slow | Turn off `multiRepoExplorer.countUntracked`, or add big generated folders to `multiRepoExplorer.exclude` |
| "Behind remote" looks wrong | It's based on your last fetch. Run **Fetch All Repos** |
| Fetch or Push fails asking for a password | Commands run without a terminal, so set up a git credential helper or SSH key |
| No **Add to Claude Chat** / **Add to Codex Chat** | Install that extension, then reload the window |
| Menu items show twice | An old build is installed too. Run `code --list-extensions \| grep multi-repo`, uninstall `local.multi-repo-explorer`, and reload the window |
| A shortcut copies text in the editor instead of the file | Click the row in **Files** first, so the tree has focus |
| A remote link goes to the wrong kind of page | The site's kind was guessed from its host name. Set it in `multiRepoExplorer.remoteHosts` |
| A remote link says the branch isn't pushed | The branch isn't on the remote yet, so the link points to the default branch. Push it, then copy the link again |

The Output log also shows how many repos were found and how long it took.

## Known limitations

- **Open in Source Control** shows the Source Control view but can't select the repo for you. VS Code has no API for that. Use **Open Repo in New Window** to get a Source Control view with only that repo.
- The branch name can't be made clickable in the tree; use the right-click menu.
- A repo nested inside another repo is only found if it's a submodule, or if the outer repo is itself a workspace folder.
- Binary files open in the diff as text.
- Only local folders are supported (not Remote SSH, WSL, or virtual workspaces).
- **Rename** and **New File** ask for the name in an input box at the top, since VS Code doesn't let extensions edit a name in place in a tree.
- File changes made from the tree can't be undone with <kbd>Cmd</kbd>/<kbd>Ctrl</kbd>+<kbd>Z</kbd> as in the built-in Explorer. Deleted items can be restored from the Trash.
- Cut items aren't dimmed until you paste them.
- Drag and drop works inside **Files**. Dropping files from Finder or the built-in Explorer onto it isn't supported.
- Other extensions' items in the built-in Explorer's menu (such as *New Java File* or *Run Tests*) can't appear here. Use **Reveal in Explorer View**.
- **Copy to AI Chat** writes `@path`, which GitHub Copilot Chat doesn't read; it uses `#file:` instead.
- **Find in Folder** can't search a folder whose name contains a comma, since the Search view splits its *files to include* at commas.

## Development

Needs Node.js 20 or later, git, and an installed VS Code for the tests that run inside it.

```bash
npm install
npm run compile        # or: npm run watch
```

Press <kbd>F5</kbd> in VS Code to run the extension in a new window (the *Extension Development Host*).

### Tests

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

- Every run uses its own temporary VS Code profile, so your settings and extensions aren't touched. The integration tests set `multiRepoExplorer.scanDepth` to 3 there, since the sample workspace has one repo 4 levels deep to test folders past the limit.
- If you run the tests from a terminal inside VS Code (or another Electron app), clear `ELECTRON_RUN_AS_NODE` first: `env -u ELECTRON_RUN_AS_NODE npm run …`.
- The chat and integration tests borrow the system clipboard and put back what was there.
- The end-to-end tests start VS Code with `--remote-debugging-port` and drive it with [Playwright](https://playwright.dev) over the DevTools protocol. They turn on custom (HTML) menus and dialogs in the test profile so they can be read and clicked. `VSCODE_PATH` is optional; the usual install location is used otherwise. When a test fails, a screenshot is saved in `.e2e-screenshots/`.

### README images

The images are drawn as HTML from the sample workspace's real output. After changing how something looks, redraw them all with `assets/images/source/render.sh` (needs Python 3 and Google Chrome).

### Releasing

Raise `version` in `package.json`, add it to `CHANGELOG.md`, commit and push, then:

```bash
npx @vscode/vsce package -o multi-repo-explorer.vsix
gh release create v1.2.0 multi-repo-explorer.vsix --title v1.2.0 --notes "..."
```

Keep the file name `multi-repo-explorer.vsix` without a version, so the `releases/latest/download/multi-repo-explorer.vsix` link in [Install](#install) always gets the newest one.

### Source layout

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

## License

[MIT](LICENSE)
