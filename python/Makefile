.PHONY: test example install ensure-uv typecheck typecheck-pyright generate-openapi-client clean-generated

test:
	PYTHONPATH=$$PYTHONPATH:. uv run pytest -s -vv tests/ $(filter-out $@,$(MAKECMDGOALS))

example:
	@args="$(filter-out $@,$(MAKECMDGOALS))"; \
	PYTHONPATH=$$PYTHONPATH:. uv run pytest -s -vv examples/ $$args

install: ensure-uv
	uv sync --all-groups --all-extras
	uv run pre-commit install --hook-type commit-msg
	uv run pre-commit install

build:
	uv pip install build
	uv run python -m build

ensure-uv:
	@if ! command -v uv &> /dev/null; then \
		curl -LsSf https://astral.sh/uv/install.sh | sh; \
	fi



typecheck:
	uv run pyright .

pdocs:
	uv run pdoc --html -o ../docs/docs/public/reference/python --template-dir ../docs/pdoc_template scenario --force

%:
	@:

# Generate OpenAPI client from LangWatch API specification
generate-openapi-client:
	@chmod +x scripts/generate_openapi_client.sh
	@./scripts/generate_openapi_client.sh

# Clean generated code
clean-generated:
	@echo "🧹 Cleaning generated code..."
	rm -rf ./scenario/_generated/
	@echo "✅ Generated code cleaned!"
