#!/usr/bin/env bash
# Creates a workspace full of git repos in every state Multi-Git Explorer shows,
# for trying the extension and checking performance.
#
#   scripts/make-sample-repos.sh <target-dir> [repo-count]
#
# Then open it with:  code --extensionDevelopmentPath="$PWD" <target-dir>
set -euo pipefail

target=${1:?usage: make-sample-repos.sh <target-dir> [repo-count]}
count=${2:-300}

export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME=Sample GIT_AUTHOR_EMAIL=sample@example.com
export GIT_COMMITTER_NAME=Sample GIT_COMMITTER_EMAIL=sample@example.com

mkdir -p "$target/.remotes"
target=$(cd "$target" && pwd)

new_repo() { # dir [remote]
  local dir=$1
  mkdir -p "$dir"
  git -C "$dir" init -q -b main
  printf '# %s\n' "$(basename "$dir")" >"$dir/README.md"
  mkdir -p "$dir/src" && printf 'export const x = 1;\n' >"$dir/src/index.ts"
  git -C "$dir" add .
  git -C "$dir" commit -q -m init
  if [[ ${2:-} == remote ]]; then
    local bare="$target/.remotes/$(echo "${dir#"$target"/}" | tr / _).git"
    git init -q --bare -b main "$bare"
    git -C "$dir" remote add origin "$bare"
    git -C "$dir" push -q -u origin main
    git -C "$dir" fetch -q
  fi
}

commit_file() { # dir file
  printf '%s\n' "$RANDOM" >>"$1/$2"
  git -C "$1" add "$2"
  git -C "$1" commit -q -m "change $2"
}

# Push a commit to the remote from a throwaway clone, so the repo falls behind.
advance_remote() { # dir commits
  local tmp
  tmp=$(mktemp -d)
  git clone -q "$(git -C "$1" remote get-url origin)" "$tmp/c"
  for ((n = 0; n < $2; n++)); do commit_file "$tmp/c" "remote.txt"; done
  git -C "$tmp/c" push -q
  rm -rf "$tmp"
  git -C "$1" fetch -q
}

# One repo per state, with names matching the design mockups.
s="$target/services"
new_repo "$s/api-gateway" remote
printf 'changed\n' >>"$s/api-gateway/README.md"
printf 'changed\n' >>"$s/api-gateway/src/index.ts"
printf 'new\n' >"$s/api-gateway/src/routes.ts" && git -C "$s/api-gateway" add src/routes.ts
printf 'todo\n' >"$s/api-gateway/NOTES.md"

new_repo "$s/auth-service" remote
git -C "$s/auth-service" switch -q -c feat/sso
git -C "$s/auth-service" push -q -u origin feat/sso
commit_file "$s/auth-service" sso.ts
commit_file "$s/auth-service" sso.ts
printf 'wip\n' >>"$s/auth-service/README.md" && git -C "$s/auth-service" stash -q

new_repo "$s/billing" remote
git -C "$s/billing" switch -q -c other
commit_file "$s/billing" README.md
git -C "$s/billing" switch -q main
commit_file "$s/billing" README.md
git -C "$s/billing" merge -q other >/dev/null 2>&1 || true

new_repo "$s/search" remote
advance_remote "$s/search" 4

new_repo "$s/payments" remote
commit_file "$s/payments" pay.ts
commit_file "$s/payments" pay.ts
advance_remote "$s/payments" 3

new_repo "$s/notification" remote

new_repo "$s/mobile-api" remote
git -C "$s/mobile-api" switch -q -c fix/login
commit_file "$s/mobile-api" login.ts

new_repo "$s/reports" remote
for f in a b c d e f g h i j k l; do printf 'x\n' >"$s/reports/$f.csv"; done

new_repo "$s/catalog" remote
git -C "$s/catalog" switch -q -c topic
commit_file "$s/catalog" README.md
commit_file "$s/catalog" src/index.ts
git -C "$s/catalog" switch -q main
commit_file "$s/catalog" README.md
git -C "$s/catalog" switch -q topic
git -C "$s/catalog" rebase -q main >/dev/null 2>&1 || true

f="$target/frontend"
new_repo "$f/web-app" remote
new_repo "$f/design-system" remote
git -C "$f/design-system" checkout -q --detach
printf 'x\n' >>"$f/design-system/README.md"
new_repo "$f/local-sandbox"

mkdir -p "$target/docs" && printf '# Docs\n' >"$target/docs/README.md"
new_repo "$target/archive/2023/q1/old-crm" remote

# Fill up to $count with clean repos spread over a few folders.
made=$(find "$target" -name .git -maxdepth 5 -not -path '*/.remotes/*' | wc -l | tr -d ' ')
for ((i = made; i < count; i++)); do
  group=$(printf 'team-%02d' $((i % 12)))
  new_repo "$target/archive/$group/repo-$(printf '%03d' "$i")"
done

echo "Created $(find "$target" -name .git -maxdepth 5 -not -path '*/.remotes/*' | wc -l | tr -d ' ') repos in $target"
