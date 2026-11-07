VSCE := npx --no-install vsce
VSIX := multi-git-explorer.vsix

.DEFAULT_GOAL := help
.PHONY: help install compile test coverage package release release-patch release-minor release-major

help: ## Show this list
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  make %-15s %s\n", $$1, $$2}'

install: ## Install dependencies
	npm ci

compile: ## Compile TypeScript into out/
	npm run compile

test: ## Run the unit tests
	npm test

coverage: ## Run every test suite and check they cover 100% of the code
	scripts/coverage.sh

package: ## Build multi-git-explorer.vsix
	rm -f $(VSIX)
	$(VSCE) package -o $(VSIX)

release: ## Release a version: make release BUMP=patch|minor|major|x.y.z
	@test -n "$(BUMP)" || { echo "usage: make release BUMP=patch|minor|major|x.y.z"; exit 1; }
	scripts/release.sh $(BUMP)

release-patch: ## Release a bug-fix version (1.2.0 -> 1.2.1)
	scripts/release.sh patch

release-minor: ## Release a feature version (1.2.0 -> 1.3.0)
	scripts/release.sh minor

release-major: ## Release a breaking version (1.2.0 -> 2.0.0)
	scripts/release.sh major
