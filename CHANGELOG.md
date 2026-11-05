# Changelog

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
