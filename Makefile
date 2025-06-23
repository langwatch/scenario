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

# Catch-all rule to prevent "No rule to make target" errors for additional arguments
%:
	@:

