.PHONY: dev build

node_modules: package.json pnpm-lock.yaml
	pnpm install
	@touch node_modules

dev: node_modules
	pnpm vite --open

build: node_modules
	pnpm test
	pnpm build
