# OpenCode

OpenCode is an open-source AI coding agent that brings the power of Gemini (and other LLMs) directly into the terminal and desktop. It is designed to be a terminal-first, autonomous development assistant.

## Project Overview

- **Core Intent:** An autonomous AI agent for software engineering.
- **Architecture:** A Bun-based monorepo managed with Turborepo.
- **Primary Tech Stack:**
  - **Runtime:** [Bun](https://bun.sh) (preferred for performance and built-in APIs).
  - **Logic & Control:** [Effect](https://effect.website) (extensive use for error handling and concurrency).
  - **Frontend:** SolidJS (used for Web Console and Desktop App).
  - **ORM:** Drizzle ORM (using SQLite via Bun).
  - **AI SDK:** Vercel AI SDK (via `@ai-sdk/*` providers).
  - **Infrastructure:** SST (Serverless Stack) for cloud components.
  - **Environment:** Nix (flakes) for development environments.

## Directory Structure

- `packages/opencode`: The main CLI application and core agent logic.
- `packages/core`: Shared libraries, models, and utility functions used across the monorepo.
- `packages/app`: The main web application (SolidJS).
- `packages/console`: The management console web application.
- `packages/desktop`: Electron-based desktop application.
- `packages/ui`: Shared UI components for SolidJS.
- `packages/llm`: Abstracted LLM provider logic.
- `packages/sdk`: SDKs for interacting with OpenCode programmatically.

## Development Workflows

### Key Commands

Run these from the project root:

- **CLI Development:** `bun run dev` (Starts the CLI in development mode).
- **Web App Development:** `bun run dev:web`.
- **Desktop App Development:** `bun run dev:desktop`.
- **Type Checking:** `bun turbo typecheck` (Uses Turborepo for parallel type checking).
- **Linting:** `bun lint` (Uses `oxlint` for extremely fast linting).
- **Preflight:** `bun run preflight` (Runs checks before committing).

### Testing

- **Constraint:** Tests **MUST NOT** be run from the root directory.
- **Execution:** Navigate to a package directory (e.g., `cd packages/opencode`) and run `bun test`.
- **Philosophy:** Prefer testing actual implementations; avoid mocks where possible. Use `bun test --timeout 30000` for longer-running agent tests.

### Commits & PRs

- **Standard:** Use Conventional Commits: `type(scope): summary`.
- **Types:** `feat`, `fix`, `docs`, `chore`, `refactor`, `test`.
- **Scopes:** `core`, `opencode`, `tui`, `app`, `desktop`, `sdk`, `plugin`.
- **Default Branch:** `dev`.

## Engineering Standards

### Coding Style

- **Functional over Imperative:** Prefer functional array methods (`map`, `filter`, `flatMap`) over `for` loops.
- **Immutability:** Prefer `const` over `let`. Use ternaries or early returns for conditional assignment.
- **Early Returns:** Avoid `else` blocks; return early.
- **Inlining:** Reduce total variable count by inlining values used only once.
- **Dot Notation:** Avoid unnecessary destructuring; use dot notation to preserve object context.
- **Effect:** Use `Effect` for side-effectful work. Do not return `Effect` from pure synchronous helpers.
- **Database:** Use `snake_case` for Drizzle field names to match column names automatically.
- **Bun APIs:** Use `Bun.file()`, `Bun.password`, etc., over Node equivalents when possible.

### AI Agent Guidance

- **Primary Branch:** Always use `dev` for development and diffs.
- **Core Logic:** The main agent loop and CLI entry point is in `packages/opencode/src/index.ts`.
- **Tool Definitions:** Agent tools are typically defined in `packages/opencode/src/tool`.
- **Config:** Check `packages/opencode/src/config` for agent and system configurations.
- **Type Safety:** Rely on `tsgo` or `bun typecheck` for validation. Never suppress type errors with `any`.

---
*This file is managed by OpenCode. Updated: 2026-05-23.*
