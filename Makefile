.PHONY: help setup go-live \
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
	@echo ""
	@echo "Go SDK (every module under go/, or GO_MODULES=\"go/voice ...\"):"
	@echo "  make go-fmt go-vet go-test go-tidy"
	@echo "  make go-check   # what go-ci runs"
	@echo "  make go-live                                # Go live suite (real keys)"
	@echo "  make go-live MODULES=\"providers/openai live\"  # some Go modules only"

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

# Run the Go SDK live suite: every module's integration-tagged tests with
# -tags integration -run Live -count=1 -p 1. Tests without their keys skip
# and are listed, with the missing variable, in the summary.
# Usage: make go-live [MODULES="providers/openai live"]
go-live:
	@go/scripts/live.sh $(MODULES)

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

# ---------------------------------------------------------------------------
# Go SDK (go/)
#
# go/ holds several Go modules: the root module github.com/langwatch/scenario/go
# and one module per directory with its own go.mod (voice, voice/tunnel/ngrok,
# providers/*, examples). Every target below runs once per module, from that
# module's directory, inside the workspace in go/go.work.
#
# Restrict a target to some modules with GO_MODULES, which is how go-ci runs one
# module per job:
#   make go-test GO_MODULES=go/voice
#   make go-vet GO_MODULES="go go/providers/openai"
# ---------------------------------------------------------------------------

GO ?= go
# Every directory under go/ that holds a go.mod, testdata excluded.
GO_ALL_MODULES := $(shell find go -name go.mod -not -path '*/testdata/*' -exec dirname {} \; 2>/dev/null | sort)
GO_MODULES ?= $(GO_ALL_MODULES)
# Modules whose tests call live models: go-test compiles them and runs nothing.
GO_COMPILE_ONLY_MODULES ?= go/examples
GO_TEST_FLAGS ?= -race -count=1 -timeout 10m
# Pinned so a staticcheck release cannot fail a pull request that changed
# nothing. 2025.1.1 is the first release that understands Go 1.25.
STATICCHECK_VERSION ?= 2025.1.1

# Every file `go list` attributes to a module's packages, build-tag-excluded
# files included. gofmt recurses into directories, so handing it a module
# directory would also check the modules nested under it.
GO_LIST_FILES := '{{$$d := .Dir}}{{range .GoFiles}}{{$$d}}/{{.}}{{"\n"}}{{end}}{{range .CgoFiles}}{{$$d}}/{{.}}{{"\n"}}{{end}}{{range .TestGoFiles}}{{$$d}}/{{.}}{{"\n"}}{{end}}{{range .XTestGoFiles}}{{$$d}}/{{.}}{{"\n"}}{{end}}{{range .IgnoredGoFiles}}{{$$d}}/{{.}}{{"\n"}}{{end}}'

.PHONY: go-modules go-fmt go-fmt-check go-vet go-staticcheck go-test \
	go-tidy go-tidy-check go-work-check go-check

# List the Go modules the targets below run over.
go-modules:
	@printf '%s\n' $(GO_MODULES)

# Rewrite every Go file with gofmt.
go-fmt:
	@set -e; for m in $(GO_MODULES); do \
		echo "==> gofmt -w ($$m)"; \
		files=$$(cd $$m && $(GO) list -e -f $(GO_LIST_FILES) ./...); \
		[ -z "$$files" ] || gofmt -w $$files; \
	done

# Fail, listing the files, when any Go file is not gofmt-formatted.
go-fmt-check:
	@status=0; for m in $(GO_MODULES); do \
		echo "==> gofmt -l ($$m)"; \
		files=$$(cd $$m && $(GO) list -e -f $(GO_LIST_FILES) ./...) || { status=1; continue; }; \
		[ -n "$$files" ] || continue; \
		bad=$$(gofmt -l $$files); \
		if [ -n "$$bad" ]; then echo "$$bad"; status=1; fi; \
	done; \
	if [ $$status -ne 0 ]; then echo "Run 'make go-fmt' and commit the result."; fi; \
	exit $$status

go-vet:
	@set -e; for m in $(GO_MODULES); do \
		echo "==> go vet ($$m)"; \
		( cd $$m && $(GO) vet ./... ); \
	done

go-staticcheck:
	@set -e; for m in $(GO_MODULES); do \
		echo "==> staticcheck $(STATICCHECK_VERSION) ($$m)"; \
		( cd $$m && $(GO) run honnef.co/go/tools/cmd/staticcheck@$(STATICCHECK_VERSION) ./... ); \
	done

# Run each module's tests with GO_TEST_FLAGS (race detector on by default).
# Modules in GO_COMPILE_ONLY_MODULES are compiled, tests included, and not run.
go-test:
	@set -e; for m in $(GO_MODULES); do \
		case " $(GO_COMPILE_ONLY_MODULES) " in \
		*" $$m "*) \
			echo "==> go test -c, compile only ($$m)"; \
			out=$$(mktemp -d); \
			( cd $$m && $(GO) test -count=1 -c -o "$$out/" ./... ) || { rm -rf "$$out"; exit 1; }; \
			rm -rf "$$out" ;; \
		*) \
			echo "==> go test $(GO_TEST_FLAGS) ($$m)"; \
			( cd $$m && $(GO) test $(GO_TEST_FLAGS) ./... ) ;; \
		esac; \
	done

# Run `go mod tidy` on each module the way a consumer would resolve it: outside
# the workspace (GOWORK=off). The other modules of this repository are pointed
# at their directories for the duration of the call and the replace directives
# are dropped again afterwards, so the result does not depend on which versions
# are tagged yet, and go.sum never records hashes for this repository's own
# modules (the workspace does not need them, and before a release they cannot
# exist).
go-tidy:
	@set -e; root=$$(pwd); for m in $(GO_MODULES); do \
		echo "==> go mod tidy ($$m)"; \
		reps=""; drops=""; \
		for o in $(GO_ALL_MODULES); do \
			[ "$$o" = "$$m" ] && continue; \
			p=$$(awk '/^module /{print $$2; exit}' $$o/go.mod); \
			reps="$$reps -replace=$$p=$$root/$$o"; drops="$$drops -dropreplace=$$p"; \
		done; \
		( cd $$m && $(GO) mod edit $$reps && s=0 && { GOWORK=off $(GO) mod tidy || s=$$?; } && \
			$(GO) mod edit $$drops && exit $$s ); \
	done

# go-tidy, then fail when it changed any go.mod or go.sum.
go-tidy-check: go-tidy
	@files="$(addsuffix /go.mod,$(GO_MODULES)) $(addsuffix /go.sum,$(GO_MODULES))"; \
	if [ -n "$$(git status --porcelain -- $$files)" ]; then \
		git status --short -- $$files; git --no-pager diff -- $$files; \
		echo "go.mod/go.sum are not tidy. Run 'make go-tidy' and commit the result."; \
		exit 1; \
	fi

# Fail when go/go.work does not list exactly the modules under go/.
go-work-check:
	@expected=$$(for m in $(GO_ALL_MODULES); do echo "$$m"; done | sort); \
	actual=$$(cd go && root=$$(cd .. && pwd) && $(GO) list -m -f '{{.Dir}}' | sed "s#^$$root/##" | sort); \
	if [ "$$expected" != "$$actual" ]; then \
		echo "go/go.work does not list every module under go/."; \
		echo "go.mod files found:"; echo "$$expected"; \
		echo "go.work modules:"; echo "$$actual"; \
		exit 1; \
	fi; \
	echo "go/go.work lists all $$(echo "$$expected" | wc -l | tr -d ' ') modules."

# Everything go-ci runs, for all modules.
go-check: go-work-check go-fmt-check go-vet go-staticcheck go-test go-tidy-check

# Catch-all rule to prevent "No rule to make target" errors for additional arguments
%:
	@:

