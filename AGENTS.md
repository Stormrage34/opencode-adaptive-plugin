## Repo Structure

- **Default branch**: `dev` (local `main` may not exist; use `dev` or `origin/dev` for diffs)
- **Package manager**: Bun 1.3+ (required)
- **Monorepo**: Workspaces in `packages/*`, run commands from specific package directories

### Key Packages
- `packages/opencode` - Core business logic, server, CLI
- `packages/app` - Shared web UI components (SolidJS)
- `packages/desktop` - Electron desktop app
- `packages/console/app` - TUI interface (SolidJS + opentui)
- `packages/sdk/js` - JavaScript SDK
- `packages/plugin` - Plugin system

## Commands

### Development
```bash
bun install                    # Install dependencies from repo root
bun dev                        # Start opencode TUI in packages/opencode directory
bun dev <directory>            # Run against specific directory
bun dev serve                  # Start headless API server (port 4096)
bun dev web                    # Start server + open web interface
bun run --cwd packages/app dev          # Test web UI changes
bun run --cwd packages/desktop dev      # Run desktop app in development
bun run --cwd packages/console/app dev  # Run console TUI
```

### Build & SDK
```bash
./packages/opencode/script/build.ts --single    # Build standalone executable
./packages/sdk/js/script/build.ts               # Regenerate JavaScript SDK
./script/generate.ts                            # Regenerate SDK after API changes
```

### Validation
```bash
bun typecheck                    # Type check all packages (from root)
bun lint                         # Run oxlint
bun turbo test:ci                # Run unit tests (from root)
bun --cwd packages/app test:e2e:local  # Run e2e tests
```

**Important**: Tests cannot run from repo root directly - use `bun turbo test:ci` or run from package dirs like `packages/opencode`.

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

## Testing

- No mocks where possible; test actual implementation
- Run tests from package directories, not repo root
- E2E tests in `packages/app/e2e` require Playwright

## Commits and PRs

### Conventional Commits
Format: `type(scope): summary`
- Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`
- Scopes: `core`, `opencode`, `tui`, `app`, `desktop`, `sdk`, `plugin`
- Examples: `fix(tui): simplify thinking toggle`, `chore(sdk): regenerate types`

### PR Requirements
- **Must reference an issue** (use `Fixes #123` or `Closes #123`)
- Keep PRs small and focused
- **UI changes**: Include screenshots/videos
- **Logic changes**: Explain how you verified it works
- No AI-generated walls of text
- Design review required for UI/core features before implementation

### Issue Templates Required
All issues must use templates (Bug report, Feature request, or Question). Blank issues auto-close after 2 hours.

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

## Environment & Config

- **Installation dir**: Respects `$OPENCODE_INSTALL_DIR`, then `$XDG_BIN_DIR`, then `$HOME/bin`, then `$HOME/.opencode/bin`
- **Data dir**: `~/.local/share/opencode/` (database at `opencode.db`)
- **Pure mode**: `--pure` flag or `OPENCODE_PURE=1` runs without external plugins
- **Logging**: `--print-logs` prints to stderr; `--log-level` sets level

## Agents

- **build** - Default, full-access agent for development
- **plan** - Read-only agent for analysis (asks permission before bash, denies edits)
- **general** - Subagent for complex searches/multistep tasks (`@general`)
