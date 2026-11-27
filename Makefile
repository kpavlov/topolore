.PHONY: dev build mcp inspector

node_modules: package.json pnpm-lock.yaml
	pnpm install
	@touch node_modules

dev: node_modules
	pnpm vite --open

build: node_modules
	pnpm test
	pnpm build

# The relay that lets agents see the tools of the page open under `make dev`. MCP clients start it from .mcp.json.
RELAY = npx -y @mcp-b/webmcp-local-relay@6.2.0 --widget-origin http://localhost:5173

mcp:
	$(RELAY)

# MCP Inspector in front of the relay: press Connect, then List Tools.
inspector:
	npx -y @modelcontextprotocol/inspector $(RELAY)
