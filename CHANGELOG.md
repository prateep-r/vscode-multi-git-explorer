# Changelog

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
