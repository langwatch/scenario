.PHONY: help

# Default target - show help
help:
	@echo "Available commands:"
	@echo ""
	@echo "Directory forwarding syntax:"
	@echo "  make <directory>/<target> [args]"
	@echo ""
	@echo "Examples:"
	@echo "  make python/test"
	@echo "  make python/example"
	@echo "  make python/install"
	@echo "  make python/build"
	@echo "  make python/typecheck"
	@echo "  make python/pdocs"
	@echo "  make python/bump-version"
	@echo "  make python/test tests/test_specific.py"

# Directory forwarding rule - handles patterns like python/target
%/:
	$(MAKE) -C $* $(filter-out $@,$(MAKECMDGOALS))

# Handle directory/target patterns
python/%:
	$(MAKE) -C python $* $(filter-out $@,$(MAKECMDGOALS))

# Build docs with optional language selection
# Usage: make build-docs [js] [py]
# Examples:
#   make build-docs        # builds all docs
#   make build-docs js     # builds only JavaScript docs
#   make build-docs py     # builds only Python docs
#   make build-docs js py  # builds both
build-docs:
	@# Check if specific languages were requested
	@BUILD_JS=false; BUILD_PY=false; \
	if [ "$(words $(MAKECMDGOALS))" -eq 1 ]; then \
		BUILD_JS=true; BUILD_PY=true; \
	else \
		for arg in $(filter-out build-docs,$(MAKECMDGOALS)); do \
			case $$arg in \
				js) BUILD_JS=true ;; \
				py) BUILD_PY=true ;; \
			esac; \
		done; \
	fi; \
	if [ "$$BUILD_JS" = "true" ]; then \
		echo "Building JavaScript docs..."; \
		pnpm -F scenario-docs install && pnpm -F scenario-docs run build; \
		pnpm -F @langwatch/scenario install && pnpm -F @langwatch/scenario run generate:api-reference; \
	fi; \
	if [ "$$BUILD_PY" = "true" ]; then \
		echo "Building Python docs..."; \
		make python/pdocs; \
	fi

# Catch-all rule to prevent "No rule to make target" errors for additional arguments
%:
	@:

