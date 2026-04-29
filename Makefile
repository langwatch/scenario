.PHONY: help setup \
	voice-pipecat-up voice-pipecat-down \
	voice-elevenlabs-provision \
	voice-demos-up voice-demos-down

# Install git hooks for worktree .env copying
setup:
	@cp .githooks/post-checkout .git/hooks/post-checkout 2>/dev/null && \
		chmod +x .git/hooks/post-checkout && \
		echo "Installed post-checkout hook." || \
		echo "No .git/hooks directory (worktree?), skipping."

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

# ---------------------------------------------------------------------------
# Voice demo infrastructure targets (issue #350)
# ---------------------------------------------------------------------------

# Start the bundled stub bot in the background.
# Writes its PID to .voice-bot.pid and polls until :8765 accepts connections.
voice-pipecat-up:
	@echo "Starting voice stub bot on :8765 ..."
	@( cd python && uv run python examples/voice/_bot/bot.py >> /tmp/voice-pipecat-bot.log 2>&1 ) & \
		echo $$! > $(CURDIR)/.voice-bot.pid
	@echo "Waiting for bot on :8765 (up to 15 s)..."
	@for i in $$(seq 1 30); do \
		if python3 -c "import socket; socket.create_connection(('127.0.0.1', 8765), 0.5)" 2>/dev/null; then \
			echo "voice stub bot: ready (PID=$$(cat $(CURDIR)/.voice-bot.pid))"; \
			exit 0; \
		fi; \
		sleep 0.5; \
	done; \
	echo "ERROR: voice stub bot did not start within 15 s. Check /tmp/voice-pipecat-bot.log"; \
	cat /tmp/voice-pipecat-bot.log 2>/dev/null || true; \
	exit 1

# Stop the bundled stub bot.
voice-pipecat-down:
	@if [ -f $(CURDIR)/.voice-bot.pid ]; then \
		PID=$$(cat $(CURDIR)/.voice-bot.pid); \
		kill -TERM "$$PID" 2>/dev/null && echo "Stopped voice stub bot (PID=$$PID)" || true; \
		rm -f $(CURDIR)/.voice-bot.pid; \
	else \
		echo "voice stub bot: no .voice-bot.pid found (already down?)"; \
	fi

# Provision (or reuse) the ElevenLabs throwaway test agent.
# Idempotent — safe to re-run. Requires ELEVENLABS_API_KEY in env or python/.env.
voice-elevenlabs-provision:
	@echo "Provisioning ElevenLabs test agent..."
	@cd python && uv run python ../scripts/provision_elevenlabs_agent.py
	@echo "Done. ELEVENLABS_AGENT_ID written to python/.env"

# Bring up all voice demo infrastructure.
voice-demos-up: voice-pipecat-up voice-elevenlabs-provision
	@echo ""
	@echo "Voice demo infra ready. Run \`pytest python/tests/voice/ -q\` to execute."

# Tear down all voice demo infrastructure.
voice-demos-down: voice-pipecat-down
	@echo "Voice demo infra stopped."

# Catch-all rule to prevent "No rule to make target" errors for additional arguments
%:
	@:

