# Convenience targets. Everything here is a thin wrapper over an npm script,
# so `make` is never required — it is just shorter to type.

.DEFAULT_GOAL := help
.PHONY: help setup build test coverage typecheck demo check clean release-dry

help: ## Show the available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[1m%-12s\033[0m %s\n", $$1, $$2}'

setup: ## Install dependencies
	npm ci || npm install

build: ## Compile TypeScript to dist/
	npm run build

typecheck: ## Typecheck without emitting
	npm run typecheck

test: ## Run the unit and integration tests
	npm test

coverage: ## Run the tests with coverage, enforcing the thresholds
	npm run coverage

demo: build ## Run the offline end-to-end demo (no API key needed)
	npm run demo

check: typecheck coverage build demo ## Everything CI runs, in the same order

clean: ## Remove build output and coverage
	npm run clean
	node -e "require('node:fs').rmSync('coverage',{recursive:true,force:true})"

release-dry: ## Show what semantic-release would publish, without publishing
	npx semantic-release --dry-run --no-ci
