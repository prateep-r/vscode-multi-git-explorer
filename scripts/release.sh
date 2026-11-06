#!/usr/bin/env bash
# Release a new version.
#
#   scripts/release.sh patch|minor|major|<x.y.z>
#
# Turns the "## Unreleased" section of CHANGELOG.md into the new version,
# bumps package.json, runs the unit tests, checks the extension packages,
# commits "Release x.y.z", tags vx.y.z, and pushes. The tag starts the Publish
# workflow (.github/workflows/publish.yml), which publishes to the VS Code
# Marketplace and creates the GitHub release with multi-git-explorer.vsix.
set -euo pipefail

cd "$(dirname "$0")/.."

BUMP="${1:-}"

die() { echo "error: $*" >&2; exit 1; }
step() { echo; echo "==> $*"; }

case "$BUMP" in
  patch | minor | major) ;;
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) die "usage: $0 patch|minor|major|<x.y.z>" ;;
esac

step "Checking the repo"
[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || die "not on main"
[ -z "$(git status --porcelain)" ] || die "uncommitted changes; commit or stash them first"
git fetch --quiet origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "main is not in sync with origin/main; pull or push first"

notes="$(awk '/^## Unreleased/{f=1; next} /^## /{f=0} f' CHANGELOG.md)"
[ -n "$(printf '%s' "$notes" | tr -d '[:space:]')" ] ||
  die "CHANGELOG.md has no \"## Unreleased\" section with entries; write what changed there first"

step "Running the unit tests"
npm test

step "Bumping the version ($BUMP)"
# Until the release commit exists, a failure puts the bumped files back.
bumped=1
restore() {
  [ $? -ne 0 ] && [ "$bumped" = 1 ] || return 0
  git checkout --quiet -- package.json package-lock.json CHANGELOG.md
  echo "Version bump undone." >&2
}
trap restore EXIT
npm version "$BUMP" --no-git-tag-version >/dev/null
VERSION="$(node -p "require('./package.json').version")"
TAG="v$VERSION"
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && die "tag $TAG already exists"
perl -pi -e "s/^## Unreleased\$/## $VERSION/" CHANGELOG.md
echo "$VERSION"

step "Checking the extension packages"
npx --no-install vsce package -o "$(mktemp -d)/check.vsix" >/dev/null

step "Committing and tagging $TAG"
git add package.json package-lock.json CHANGELOG.md
git commit --quiet -m "Release $VERSION"
bumped=0
git tag "$TAG"

step "Pushing main and $TAG"
git push --quiet origin main "$TAG"

repo="$(git remote get-url origin | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')"
echo
echo "Released $VERSION. GitHub Actions now publishes it to the Marketplace and creates the GitHub release:"
echo "  https://github.com/$repo/actions/workflows/publish.yml"
