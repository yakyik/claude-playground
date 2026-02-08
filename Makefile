# ─── claude-playground Makefile ──────────────────────────────────────────────
#
# Self-documenting: run `make help` to see all targets.
# Convention: targets with ## comments are shown in help output.

# ─── Variables ───────────────────────────────────────────────────────────────

BASTION_DIR    := bastion-mcp-server
GO_CMD         := go
GO_BIN         := ./playground-ctl
COMPOSE_FILE   := $(BASTION_DIR)/docker-compose.yml
COMPOSE_DEV    := $(BASTION_DIR)/docker-compose.dev.yml

# ─── Meta ────────────────────────────────────────────────────────────────────

.PHONY: help
help: ## Show this help message
	@grep -E '^[a-zA-Z0-9_-]+:.*## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*## "}; {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

.DEFAULT_GOAL := help

# ─── Install ─────────────────────────────────────────────────────────────────

.PHONY: install
install: ## Install all dependencies (npm + go)
	cd $(BASTION_DIR) && npm ci
	$(GO_CMD) mod download

# ─── Build ───────────────────────────────────────────────────────────────────

.PHONY: build build-ts build-go

build: build-ts build-go ## Build everything (TypeScript + Go)

build-ts: ## Build TypeScript MCP server
	cd $(BASTION_DIR) && npm run build

build-go: ## Build playground-ctl Go CLI
	$(GO_CMD) build -o $(GO_BIN) ./cmd/playground-ctl/...

# ─── Test ────────────────────────────────────────────────────────────────────

.PHONY: test test-watch

test: ## Run all tests
	cd $(BASTION_DIR) && npm test

test-watch: ## Run tests in watch mode
	cd $(BASTION_DIR) && npm run test:watch

# ─── Lint ────────────────────────────────────────────────────────────────────

.PHONY: lint lint-ts lint-go typecheck

lint: lint-ts lint-go ## Run all linters

lint-ts: ## Lint TypeScript
	cd $(BASTION_DIR) && npm run lint

lint-go: ## Lint Go (vet)
	$(GO_CMD) vet ./...

typecheck: ## TypeScript type checking
	cd $(BASTION_DIR) && npx tsc --noEmit

# ─── Dev ─────────────────────────────────────────────────────────────────────

.PHONY: dev
dev: ## Start MCP server in dev mode (auto-reload)
	cd $(BASTION_DIR) && npm run dev

# ─── Docker ──────────────────────────────────────────────────────────────────

.PHONY: docker-build docker-up docker-down docker-logs

docker-build: ## Build Docker image
	docker build -t bastion-mcp-server -f $(BASTION_DIR)/docker/Dockerfile $(BASTION_DIR)

docker-up: ## Start Docker Compose stack (production)
	docker compose -f $(COMPOSE_FILE) up -d

docker-down: ## Stop Docker Compose stack
	docker compose -f $(COMPOSE_FILE) down

docker-logs: ## Tail Docker Compose logs
	docker compose -f $(COMPOSE_FILE) logs -f

# ─── Token ───────────────────────────────────────────────────────────────────

.PHONY: generate-token
generate-token: ## Generate a JWT token (requires BASTION_JWT_SECRET)
ifndef BASTION_JWT_SECRET
	$(error BASTION_JWT_SECRET is not set. Run: export BASTION_JWT_SECRET=$$(openssl rand -hex 32))
endif
	node $(BASTION_DIR)/scripts/generate-token.mjs --secret "$(BASTION_JWT_SECRET)"

# ─── Config ──────────────────────────────────────────────────────────────────

.PHONY: config-init config-validate

config-init: ## Scaffold config from example templates
	@if [ ! -f playground.yaml ]; then \
		cp $(BASTION_DIR)/config/playground.yaml.example playground.yaml; \
		echo "Created playground.yaml from template"; \
	else \
		echo "playground.yaml already exists — skipping"; \
	fi

config-validate: ## Validate environment and tool versions
	@echo "Checking required tools..."
	@command -v node >/dev/null 2>&1 || { echo "  MISSING: node"; exit 1; }
	@echo "  node: $$(node --version)"
	@command -v go >/dev/null 2>&1 || { echo "  MISSING: go"; exit 1; }
	@echo "  go: $$(go version | awk '{print $$3}')"
	@command -v docker >/dev/null 2>&1 || { echo "  MISSING: docker (optional)"; }
	@command -v docker >/dev/null 2>&1 && echo "  docker: $$(docker --version | awk '{print $$3}' | tr -d ',')" || true
	@echo ""
	@echo "Checking environment variables..."
	@if [ -n "$$BASTION_JWT_SECRET" ]; then \
		SECRET_LEN=$$(printf '%s' "$$BASTION_JWT_SECRET" | wc -c | tr -d ' '); \
		if [ "$$SECRET_LEN" -lt 32 ]; then \
			echo "  WARNING: BASTION_JWT_SECRET is only $$SECRET_LEN chars (recommend >= 32)"; \
		else \
			echo "  BASTION_JWT_SECRET: set ($$SECRET_LEN chars)"; \
		fi; \
	elif [ -n "$$BASTION_API_KEY" ]; then \
		echo "  BASTION_API_KEY: set"; \
	else \
		echo "  WARNING: Neither BASTION_JWT_SECRET nor BASTION_API_KEY is set"; \
	fi
	@echo ""
	@echo "Validation complete."

# ─── Provision ───────────────────────────────────────────────────────────────

.PHONY: provision-aws provision-gcp provision-k8s

provision-aws: build-go ## Provision bastion on AWS
	$(GO_BIN) up --provider aws

provision-gcp: build-go ## Provision bastion on GCP
	$(GO_BIN) up --provider gcp

provision-k8s: build-go ## Provision bastion on Kubernetes
	$(GO_BIN) up --provider k8s

# ─── Teardown ────────────────────────────────────────────────────────────────

.PHONY: teardown-aws teardown-gcp teardown-k8s

teardown-aws: ## Tear down AWS infrastructure
	$(GO_BIN) down --provider aws

teardown-gcp: ## Tear down GCP infrastructure
	$(GO_BIN) down --provider gcp

teardown-k8s: ## Tear down Kubernetes deployment
	$(GO_BIN) down --provider k8s

# ─── Status ──────────────────────────────────────────────────────────────────

.PHONY: status
status: ## Show playground infrastructure status
	$(GO_BIN) status

# ─── Security ────────────────────────────────────────────────────────────────

.PHONY: security-check
security-check: ## Run security checks (npm audit + go vet + config validation)
	@echo "=== npm audit ==="
	cd $(BASTION_DIR) && npm audit --omit=dev || true
	@echo ""
	@echo "=== go vet ==="
	$(GO_CMD) vet ./...
	@echo ""
	@echo "=== config validation ==="
	@$(MAKE) config-validate

# ─── Clean ───────────────────────────────────────────────────────────────────

.PHONY: clean
clean: ## Remove build artifacts
	rm -rf $(BASTION_DIR)/dist
	rm -f $(GO_BIN)
