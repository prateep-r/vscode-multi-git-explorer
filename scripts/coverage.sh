#!/usr/bin/env bash
# Measures how much of the extension the unit, integration and end-to-end
# tests run, all together, and fails below 100% of lines, branches and
# functions. Files copied from VS Code (src/core/vs) aren't counted; they
# come with VS Code's own tests. The report is written to coverage/index.html.
#
#   scripts/coverage.sh
#
# Takes about 4 minutes: it makes fresh sample workspaces and opens VS Code
# three times. Set VSCODE_PATH to use another VS Code.
set -euo pipefail

cd "$(dirname "$0")/.."

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
# Set COVERAGE_RAW=<dir> to keep the raw V8 data there, for listing what's left.
v8="${COVERAGE_RAW:-$tmp/v8}"
rm -rf "$v8"
mkdir -p "$v8"
# Set when run from a terminal inside VS Code; it would start Code as plain Node.
unset ELECTRON_RUN_AS_NODE

step() { echo; echo "==> $*"; }

npx tsc -p .

step "Unit tests"
NODE_V8_COVERAGE="$v8" node --test "out/test/**/*.test.js"

step "Integration tests"
scripts/make-sample-repos.sh "$tmp/sample-ws" 300 >/dev/null
NODE_V8_COVERAGE="$v8" node out/integration/run.js "$tmp/sample-ws"

step "Integration tests, multi-root"
scripts/make-sample-repos.sh "$tmp/multi-ws" 40 >/dev/null
NODE_V8_COVERAGE="$v8" node out/integration/run.js "$tmp/multi-ws" --multi-root

step "End-to-end tests"
scripts/make-sample-repos.sh "$tmp/e2e-ws" 40 >/dev/null
NODE_V8_COVERAGE="$v8" node out/e2e/run.js "$tmp/e2e-ws"

step "Coverage"
npx --no-install c8 report --temp-directory "$v8" --check-coverage --lines 100 --branches 100 --functions 100 --statements 100
