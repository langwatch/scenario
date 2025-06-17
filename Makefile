.PHONY: test example install ensure-uv bump-version typecheck typecheck-pyright

test:
	PYTHONPATH=$$PYTHONPATH:. uv run pytest -s -vv tests/ $(filter-out $@,$(MAKECMDGOALS))

example:
	@args="$(filter-out $@,$(MAKECMDGOALS))"; \
	PYTHONPATH=$$PYTHONPATH:. uv run pytest -s -vv examples/ $$args

install: ensure-uv
	uv sync --all-groups --all-extras
	uv run pre-commit install --hook-type commit-msg
	uv run pre-commit install

ensure-uv:
	@if ! command -v uv &> /dev/null; then \
		curl -LsSf https://astral.sh/uv/install.sh | sh; \
	fi

bump-version:
	@echo "🔍 Analyzing commits since last version..."
	uv run cz bump --major-version-zero --allow-no-commit --dry-run
	@echo ""
	@read -p "Proceed with version bump? [y/N] " confirm && [ "$$confirm" = "y" ] || [ "$$confirm" = "Y" ] || exit 1
	uv run cz bump --major-version-zero --allow-no-commit
	@echo "✅ Version bumped and tagged!"

typecheck:
	uv run pyright .

pdocs:
	uv run pdoc --html -o ./docs/docs/public/reference/python --template-dir ./docs/pdoc_template scenario --force

%:
	@:

# This only works if you have the openapi json locally
generate-openapi-client:
	openapi-python-client generate --path ../langwatch-saas/langwatch/langwatch/src/app/api/openapiLangWatch.json --output-path ./langwatch_api_client --overwrite
	uv pip install -e ./langwatch_api_client