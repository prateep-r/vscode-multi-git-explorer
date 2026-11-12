# Changelog

## 1.4.0

- **Fetch All, Pull All, Push All and Refresh All on a folder or group.** Right-click a folder that holds repos but isn't one, or a group in **Git Repositories** such as *Behind remote*, to run git in every repo it counts, a few at a time (`maxConcurrency`), with progress you can cancel.
  - **Pull All** only fast-forwards (`git pull --ff-only`). A repo that would need a merge, or whose changes are in the way, is skipped and left as it was.
  - **Push All** asks first and names the repos. A branch pushed for the first time gets an upstream, as with **Push**.
  - A repo that fails or is skipped doesn't stop the others. The message at the end lists them, and **Show Details** shows git's output in the *Multi-Git Explorer* output.
  - Choosing the repos runs no git, except that **Push All** checks the repos not checked yet (in a large workspace, those off screen) to see what they have to push.
- While filtering, folder and repo rows find the repos below them by a binary search instead of going through every repo.
- A repo whose row is drawn while its status is being checked, such as one shown in an editor's breadcrumbs, is no longer checked a second time right after.

## 1.3.3

Lighter on workspaces of more than 100 repos, such as one with nearly a thousand. Smaller workspaces work as before.

- Coming back to the VS Code window, and the check every `backgroundRefreshMinutes`, re-check only the repos whose commits, branches, index or stash changed, and the repo of the active editor, instead of running `git status` in every repo. Which repos changed is read from `.git`, without running git. Every repo is still checked every 30 minutes, and by **Refresh**.
- When the workspace opens, the repos on screen are checked at once and the rest 5 seconds later, so VS Code and other extensions can start first.

For every workspace:

- Dimming `.gitignore`d files runs git in at most 4 repos at a time, instead of one per repo on screen all at once, and stops when the extension does.
- A change in a submodule, such as a new commit or an edited file, now also updates the repo it's in.

## 1.3.2

- **Double-click a file to keep it open**, like the built-in Explorer. A single click still opens a preview that the next click replaces. `workbench.list.openMode` is followed too. The same goes for the diffs of changed files.
- **Reveal in Multi-Git Explorer** on an editor tab's right-click menu, and in the Command Palette, selects the file in the file tree, like **Reveal in Explorer View**.
- The file tree follows more of the built-in Explorer's settings:
  - `explorer.incrementalNaming` names pasted copies `app copy.ts` or `app.1.ts`, or asks before replacing.
  - `explorer.decorations.colors` and `explorer.decorations.badges` turn off row colors and badges. Git Repositories keeps them.
  - `explorer.copyPathSeparator` sets the separator Copy Path uses. Several paths are copied with Windows line endings on Windows.
  - `explorer.enableDragAndDrop` turns off dropping items in the tree.
- Fixed **Reveal in Multi-Git Explorer** on a file outside the workspace, which stopped the extension.
- Fixed **Refresh** forgetting the repos found with **Scan This Folder**.
- Repos that appear or go away on disk, such as with `git clone` or by deleting their folder, now show up or disappear without **Refresh**.
- A `.gitignore` written right after it's made, or made and removed quickly, is now read correctly with `explorer.excludeGitIgnore` on.
- **Copy Relative Path** on a workspace folder copies its name instead of its full path.
- The file tree finds the repo of each row faster: drawing rows no longer gets slower with more repos.
- **Switch Branch** marks the current branch from git itself, so it's right even while the repo's status is a moment old.
- Like the built-in Explorer, symbolic links show `⤷`, files of unknown type `?`, and workspace folders that can't be read `!`, and excluded items shown because an editor has them open are dimmed.

## 1.3.1

- Fixed git commands failing now and then when git finished before reading its input, which stopped the 1.3.0 release from reaching the Marketplace. 1.3.1 is the first published release with the 1.3.0 changes.

## 1.3.0

- **Undo and redo** with <kbd>Cmd</kbd>/<kbd>Ctrl</kbd>+<kbd>Z</kbd> and <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Y</kbd> in the file tree, for new files and folders, rename, move, paste, delete and dropped files, like the built-in Explorer: undoing a delete brings back files up to 5 MB, it asks first per `explorer.confirmUndo`, and `explorer.enableUndo` turns it off.
- **Drop files from Finder (or anywhere outside the tree)** to copy them in, like the built-in Explorer: it asks before replacing a file with the same name, offers to add folders dropped on a workspace folder to the workspace, and opens a single dropped file when `explorer.autoOpenDroppedFile` is on.
- **File nesting**, following `explorer.fileNesting.enabled`, `.patterns` and `.expand`: related files show under their parent, such as `package-lock.json` under `package.json`, with VS Code's own matching. Cutting, copying, deleting or dragging a closed parent takes its nested files along, as in the built-in Explorer.
- **Compact folders**, following `explorer.compactFolders`: when you open a folder that holds only one folder, the two show as one row, such as `src/main/java`, like the built-in Explorer. Commands on the row act on its last folder.
- **`.gitignore`d files are dimmed**, as VS Code's git extension dims them in the built-in Explorer, and **hidden when `explorer.excludeGitIgnore` is on**, read the same way as the built-in Explorer reads `.gitignore`.
- **The active editor's file is selected in the file tree**, with the folders above it expanded, following `explorer.autoReveal` and `explorer.autoRevealExclude` like the built-in Explorer.
- **Problems show on files and folders**, like the built-in Explorer: files with errors or warnings are colored and show how many, and the folders above them are colored too. Follows `problems.decorations.enabled`.
- **Cut items are dimmed** until you paste them, and <kbd>Escape</kbd> cancels the cut.
- **Keyboard shortcuts act on the focused row**, like the built-in Explorer: the row you moved to with the arrow keys, or the whole selection when that row is part of it. Before, they acted on the selected rows only.
- **More of the built-in Explorer's keys**: <kbd>Enter</kbd> renames on macOS (<kbd>F2</kbd> still works), <kbd>Space</kbd> opens a file and keeps focus in the tree, <kbd>Enter</kbd> (<kbd>Cmd</kbd>+<kbd>Down</kbd> on macOS) opens it and moves focus to the editor, <kbd>Shift</kbd>+<kbd>Delete</kbd> (<kbd>Cmd</kbd>+<kbd>Option</kbd>+<kbd>Backspace</kbd>) deletes permanently, and <kbd>Delete</kbd> also deletes on macOS.
- **Open With…** on files, and **Add Folder to Workspace…** / **Remove Folder from Workspace** on workspace folders.
- **Sorted like the built-in Explorer**, following `explorer.sortOrder` (folders first, mixed, files first, by type, by date modified, or files with nested files first), `explorer.sortOrderLexicographicOptions` and `explorer.sortOrderReverse`. Names are compared with VS Code's own code.
- **`files.exclude` works as in the built-in Explorer**: every glob pattern (such as `**/*.pyc`), `when` clauses, `!` exceptions, and excluded files stay shown while an editor shows them. Before, only patterns like `**/node_modules` were understood. The pattern matching is VS Code's own code.
- **Copy Remote File URL** and **Open on Remote (Web)** no longer keep part of a password in the link when a remote URL's password contains an unescaped `@`.
- Turned off in Restricted Mode, like VS Code's own Git, since a repo's git config can run programs. Trust the folder to use it.

## 1.2.2

- A shorter README and Marketplace page, without the notes on moving from Multi-Repo Explorer.

## 1.2.1

- **Renamed to Multi-Git Explorer**, and on the VS Code Marketplace as [`prateep-r.multi-git-explorer`](https://marketplace.visualstudio.com/items?itemName=prateep-r.multi-git-explorer), so VS Code installs and updates it for you.
  - Settings are now `multiGitExplorer.*` instead of `multiRepoExplorer.*`. Your old settings are copied over the first time it starts.
  - If Multi-Repo Explorer (`prateep-r.multi-repo-explorer`) is still installed, it offers to uninstall it, so you don't get two side bars.
- A Marketplace icon.
- A clearer README and Marketplace page, focused on using the extension. Notes for contributors moved to `CONTRIBUTING.md`.

## 1.2.0

- **Right-click menu like the built-in Explorer** in the file tree: Open to the Side, Reveal in Finder, Open in Integrated Terminal, Reveal in Explorer View, Find in Folder, Select for Compare / Compare with Selected, Open Timeline, Cut / Copy / Paste, Copy Path / Copy Relative Path, Rename and Delete, with the built-in Explorer's keyboard shortcuts.
- **Drag and drop** items onto a folder to move them.
- **Copy Remote File URL** and **Open on Remote (Web)** link to a file or folder on GitHub, GitLab, Bitbucket, Azure DevOps or Gitea. Set the kind of self-hosted sites in `multiRepoExplorer.remoteHosts`.
- **Copy to AI Chat** replaces Copy to Claude Chat and Copy to Codex Chat, which copied the same `@path` text. It shows on every row, also without either extension installed.
- The side bar is titled **Multi-Repo Explorer**, and the repo list **Git Repositories**.
- Clicking a file in the file tree opens it as a preview and keeps focus in the tree, like the built-in Explorer, so keyboard shortcuts act on the row instead of the editor.
- A file removed with `git rm --cached` shows as untracked instead of deleted, since it's still on disk.
- Menu items are limited to this extension's views, so they no longer show up twice next to an older build's.

## 1.1.0

- The side bar opens on the Repo Explorer when a window with a folder opens, instead of the built-in Explorer. Turn this off with `multiRepoExplorer.showOnStartup`.
- Repos are searched for 10 folder levels deep instead of 3, so repos kept in folders like `apps/services/team/project/` show their branch. `multiRepoExplorer.scanDepth` no longer has an upper limit of 10, so it can be raised for deeper repos.
- Expanding a folder marked `not scanned` searches it, so the repos inside show their branch without using **Scan This Folder**.

## 1.0.0

The first release.

- **Repo Explorer**: a file tree like the built-in Explorer, with each repo's branch and status written after its name, and a summary on folders that contain repos. New File and New Folder work from its title bar and right-click menu.
- **Git Repos**: every repo, grouped by what needs attention (conflicts, uncommitted changes, not pushed, behind remote, clean), with a filter by path or branch name.
- **Filters**: show only repos with changed files, repos not pushed, or repos behind their remote. With the changed-files filter, only the changed files are listed, and clicking one opens its diff. Folders in `multiRepoExplorer.exclude` and `files.exclude` stay hidden.
- **Switch Branch**: pick a local or remote branch, or create one, with ahead/behind counts for each branch. Offers to stash uncommitted changes when they would be overwritten.
- **Right-click menus** to open a repo in Source Control, view all its changes, fetch, pull, push, open a terminal, open it in a new window, or copy the branch name.
- **Claude Code and Codex**: add a file to the chat, or copy a folder's `@path/` for it.
- **Status bar**: the branch of the repo you're editing, and totals for all repos.
- **Optional badges in the built-in Explorer** (`multiRepoExplorer.decorateExplorer`).
- Fast with hundreds of repos: branches and in-progress operations are read straight from `.git`, and `git status` runs through a queue that checks the repos you're working in first.
