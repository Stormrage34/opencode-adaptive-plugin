## Repo Structure

- **Default branch**: `dev` (local `main` may not exist; use `dev` or `origin/dev` for diffs)
- **Package manager**: Bun 1.3+ (required)
- **Monorepo**: Workspaces in `packages/*`, `packages/console/*`, `packages/sdk/js`, `packages/slack`. Run commands from specific package directories.

### Key Packages
- `packages/opencode` - Core business logic, server, CLI (primary dev target)
- `packages/app` - Shared web UI components (SolidJS)
- `packages/desktop` - Electron desktop app
- `packages/console/app` - TUI interface (SolidJS + opentui)
- `packages/sdk/js` - JavaScript SDK (regenerate via `./script/generate.ts`)
- `packages/plugin` - Plugin system (`@opencode-ai/plugin`)

## Commands

### Development
```bash
bun install                    # Install dependencies from repo root
bun dev                        # Start opencode TUI in packages/opencode directory
bun dev <directory>            # Run against specific directory
bun dev serve                  # Start headless API server (port 4096)
bun dev web                    # Start server + open web interface (proxy only, not for local UI changes)
bun run --cwd packages/app dev          # Test web UI changes (requires server running separately)
bun run --cwd packages/desktop dev      # Run desktop app in development
bun run --cwd packages/console/app dev  # Run console TUI (may need ulimit -n 10240)
```

**Note**: `bun dev` is the local development equivalent of the built `opencode` command. Both run the same CLI interface with identical flags.

**Important**: `bun dev web` proxies `https://app.opencode.ai`, so local UI/CSS changes will not show there. For local UI changes, run backend and app dev servers separately:
- Backend: `bun run --cwd packages/opencode --conditions=browser ./src/index.ts serve --port 4096`
- App: `bun run --cwd packages/app dev -- --port 4444`
- Open `http://localhost:4444` to verify UI changes.

### Build & SDK
```bash
./packages/opencode/script/build.ts --single    # Build standalone executable
./packages/sdk/js/script/build.ts               # Regenerate JavaScript SDK
./script/generate.ts                            # Regenerate SDK after API changes (runs both above)
```

### Validation
```bash
bun typecheck                    # Type check all packages (from root, uses turbo)
bun lint                         # Run oxlint (from root)
bun turbo test:ci                # Run unit tests across all packages (from root)
bun --cwd packages/app test:e2e:local  # Run e2e tests (Playwright)
```

**Critical**: Tests cannot run from repo root directly - root `test` script exits 1. Use `bun turbo test:ci` or run from package directories like `packages/opencode`. The `packages/opencode` test script loops over `test/**/*.test.ts` files.

**CI-only gates**: `test:httpapi` (from `packages/opencode`) exercises HttpApi, auth, and effect gates. Runs on Linux in CI only.

### Database Migrations
```bash
# From packages/opencode directory
bun run db generate --name <slug>   # Generate Drizzle migration
```
Schema files live in `src/**/*.sql.ts`, migrations output to `./migration`.

## Architecture Notes

- **Effect v4**: Core uses Effect v4 beta APIs with `Effect.gen`, `Effect.fn`, `Effect.cached`
- **Services**: Use `makeRuntime` for shared services, `InstanceState` for per-directory state
- **Database**: Drizzle ORM with SQLite, snake_case column naming
- **TUI**: Built with SolidJS and opentui in `packages/console/app`
- **Dev server**: `bun dev` runs TUI in `packages/opencode` by default; passes directory argument to target different projects

## Testing

- No mocks where possible; test actual implementation
- Run tests from package directories, not repo root
- E2E tests in `packages/app/e2e` require Playwright

### Test Isolation Gotcha
Global singletons (`Database`, `SyncEvent`, `GlobalBus`) are NOT isolated between test files — failures cascade. The test harness uses per-file isolation (`for f in test/**/*.test.ts; do bun test "$f"; done`) to avoid global state pollution. Use `withProcessEnv` helper for env isolation. `test/preload.ts` sets up temp XDG dirs and in-memory SQLite — but `initProjectors()` and `Log.init()` were removed to prevent pollution.

### Effect Testing Patterns
Use `testEffect(...)` from `test/lib/effect.ts` for Effect services. Prefer `it.instance(...)` for scoped temp directories. Use `Layer.mock` for partial service stubs. Never use `Effect.sleep()` for synchronization — wait on published readiness signals (`pollWithTimeout`, `awaitWithTimeout`, `llm.wait(n)`, `SessionStatus.Service.get`, etc.).

### Running Single Tests
From `packages/opencode`:
```bash
bun test test/path/to/file.test.ts
```

## Style Guide

### General Principles
- Use Bun APIs when possible (`Bun.file()`, etc.)
- Avoid `try`/`catch` where possible; prefer `.catch(...)`
- Avoid `any` type; use precise types
- Prefer functional array methods with type guards on `filter`
- Keep logic inline unless composable or reused
- Use `const` over `let`; ternaries or early returns over reassignment
- Avoid `else` statements; use early returns
- Avoid unnecessary destructuring; use dot notation

### Complex Logic Pattern
```ts
export function loadThing(input: unknown) {
  const config = requireConfig(input)
  const metadata = readMetadata(input)
  return createThing({ config, metadata })
}

function requireConfig(input: unknown) { ... }
function readMetadata(input: unknown) { ... }
```

### Drizzle Schema
Use snake_case for field names:
```ts
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})
```

### Config Modules
In `src/config`, follow self-export pattern:
```ts
export * as ConfigAgent from "./agent"
```

## Effect v4 Patterns
- Use `Effect.fnUntraced` for service implementations (skip tracing overhead).
- Concurrency: **never use `unbounded`** — all concurrency sites must be bounded (5/8/10/20 depending on operation).

## Commits and PRs

### Conventional Commits
Format: `type(scope): summary`
- Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`
- Scopes: `core`, `opencode`, `tui`, `app`, `desktop`, `sdk`, `plugin`
- Examples: `fix(tui): simplify thinking toggle`, `chore(sdk): regenerate types`

### PR Requirements
- **Must reference an issue** (use `Fixes #123` or `Closes #123` in PR description)
- Keep PRs small and focused
- **UI changes**: Include screenshots/videos showing before/after
- **Logic changes**: Explain how you verified it works (what you tested, how to reproduce)
- No AI-generated walls of text
- Design review required for UI/core features before implementation

### Issue Templates Required
All issues must use templates (Bug report, Feature request, or Question). Blank issues auto-close after 2 hours.

### PR Titles
Follow conventional commit standards. Optional scope indicates package:
- `docs: update contributing guidelines`
- `fix: resolve crash on startup`
- `feat(app): add dark mode support`
- `fix(desktop): resolve crash on startup`
- `chore: bump dependency versions`

## Debugger Setup

Bun debugging is limited. Most reliable method:
```bash
# Run manually and attach debugger
bun run --inspect=<url> dev ...

# For TUI with server breakpoints
bun dev spawn

# Debug server separately
bun run --inspect=ws://localhost:6499/ --cwd packages/opencode ./src/index.ts serve --port 4096
```

Export `BUN_OPTIONS=--inspect=ws://localhost:6499/` to avoid repeating flags.

### VSCode Setup
If you use VSCode, example configurations exist at `.vscode/settings.example.json` and `.vscode/launch.example.json`.

Some debug methods can be problematic:
- Debug configurations with `"request": "launch"` can have breakpoints incorrectly mapped
- The same problem arises when running OpenCode in the VSCode `JavaScript Debug Terminal`

## Environment & Config

- **Installation dir**: Respects `$OPENCODE_INSTALL_DIR`, then `$XDG_BIN_DIR`, then `$HOME/bin`, then `$HOME/.opencode/bin`
- **Data dir**: `~/.local/share/opencode/` (database at `opencode.db`)
- **Pure mode**: `--pure` flag or `OPENCODE_PURE=1` runs without external plugins
- **Logging**: `--print-logs` prints to stderr; `--log-level` sets level

**CI gotcha**: On Windows, set `OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER=true` to avoid filewatcher issues (see `.github/workflows/test.yml`).

## Agents

- **build** - Default, full-access agent for development
- **plan** - Read-only agent for analysis (asks permission before bash, denies edits)
- **general** - Subagent for complex searches/multistep tasks (`@general`)

## Plugin Development

- Plugins are TypeScript modules (not Python sidecars).
- Export `Plugin` function returning hooks (`tool`, `auth`, `chat.params`, `chat.message`, `event`, etc.).
- EventV2 subscription: use `event` hook to receive `session.next.*` events (requires `experimentalEventSystem` flag).
- See `packages/plugin-adaptive/` for reference implementation.

## Gotchas & Tips

### UI Development
- NEVER try to restart the app or server process during debugging.
- `opencode dev web` proxies production; use separate servers for local UI changes (see Dev section).
- In SolidJS, always prefer `createStore` over multiple `createSignal` calls.
- ALWAYS USE PARALLEL TOOLS when applicable for tool calling.

### Browser Automation
Use `agent-browser` for web automation. Run `agent-browser --help` for commands. Core workflow:
1. `agent-browser open <url>`
2. `agent-browser snapshot -i` (get interactive elements with refs)
3. `agent-browser click @e1` / `fill @e2 "text"`
4. Re-snapshot after page changes
