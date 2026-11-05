# Multi-Repo Git Status

See the branch and state of every git repository in your workspace at a glance — built to stay fast with hundreds of repos.

## What it shows

**Repo Explorer** (Multi-Repo Git Status sidebar) is a file tree like the built-in Explorer, with each repo's branch and state written after its name:

```
services          9 repos · !2 ●2 ↑2 ↓2
  api-gateway     ⎇ main · ●2 +1 ?1
  auth-service    ⎇ feat/sso · ↑2 · ≡1
  billing         ⎇ main · MERGING · ✕1 · ↑1
docs              no git
archive/2023/q1   not scanned
```

**Git Repos** groups every repo by what needs attention, problems first: conflict or unfinished merge/rebase, check failed, uncommitted changes, not pushed, behind remote, checking, clean. Filter by repo path or branch name.

**Built-in Explorer** folders that are repos get a color and a short badge (VS Code allows at most two characters there), with full details in the tooltip.

**Status bar** shows the branch of the repo you are editing in, and totals for all repos.

| Badge | Meaning |
| --- | --- |
| `!` | Conflicted files |
| `M` `R` `C` `V` | Merge, rebase, cherry-pick or revert in progress |
| `5`, `9+` | Files with uncommitted changes |
| `D` | Detached HEAD |
| `↕` | Diverged: commits to push and to pull |
| `↑2` | Commits not pushed |
| `↑` | Branch has no upstream yet |
| `↓4` | Behind upstream (as of the last fetch) |
| `…` | Still checking |
| `⚠` | Status could not be read |
| none | Clean and in sync |

In descriptions: `●` modified, `+` staged, `?` untracked, `✕` conflicted, `≡` stash.

## Right-click a repo

Open in Source Control · View All Changes · Switch Branch… · Fetch · Pull · Push · Open Terminal Here · Open Repo in New Window · Copy Branch Name. In the built-in Explorer these are under **Git Repo**.

*Open in Source Control* opens the repo in VS Code's Git and shows the Source Control view. VS Code has no public API to select one repo in that view, so other repos may still be listed. *Open Repo in New Window* gives a Source Control view with only that repo.

## How it stays fast

- Branch, detached HEAD and unfinished operations are read straight from files in `.git`, with no git process. With 300 repos this takes about 100 ms.
- `git status` runs through a queue (6 at a time by default): repos you are working in first, then repos on screen, then the rest in the background.
- One file watcher for the whole workspace (VS Code's own); changes are debounced per repo.
- Status checks set `GIT_OPTIONAL_LOCKS=0`, so they never take `index.lock` or get in the way of your own git commands.
- Nothing is fetched automatically. Use **Fetch All Repos** when you want fresh ahead/behind numbers.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `multiRepoGit.scanDepth` | `3` | Folder levels below each workspace folder to search |
| `multiRepoGit.exclude` | `node_modules`, `vendor`, `dist`, … | Folder names never searched |
| `multiRepoGit.maxConcurrency` | `6` | Git processes at the same time |
| `multiRepoGit.countUntracked` | `true` | Turn off for faster checks in big repos |
| `multiRepoGit.refreshOnFocus` | `true` | Re-check when the window gets focus |
| `multiRepoGit.backgroundRefreshMinutes` | `5` | Background re-check interval; `0` turns it off |

Colors can be changed with `workbench.colorCustomizations` (`multiRepoGit.conflictForeground`, `multiRepoGit.dirtyForeground`, `multiRepoGit.aheadForeground`, `multiRepoGit.behindForeground`, `multiRepoGit.pendingForeground`, `multiRepoGit.errorForeground`).

## Development

```bash
npm install
npm test                      # unit tests
scripts/make-sample-repos.sh /tmp/sample-ws 300
VSCODE_PATH="/Applications/Visual Studio Code.app/Contents/MacOS/Code" \
  npm run test:integration -- /tmp/sample-ws
```

Press F5 in VS Code to run the extension in a new window.

Repos nested inside another repo are only found when they are submodules (or when the outer repo is a workspace folder).
