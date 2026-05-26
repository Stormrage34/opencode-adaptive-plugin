# Adaptive Plugin AGENTS.md

High-signal facts an agent would otherwise guess wrong while working on this plugin.

## Commands
- Run tests: `bun test src/adaptive.test.ts` (or `bun run test`)
- Typecheck: `bun run typecheck`
- Use in OpenCode: add to `opencode.jsonc`:
  ```jsonc
  {
    "plugin": [["./packages/plugin-adaptive", { "debug": false }]]
  }
  ```

## Configuration
- `debug` (boolean, default `false`): enables verbose plugin logging.
- `dbPath` (string, default `.opencode_telemetry.db`): SQLite DB path relative to OpenCode working directory.

## Testing
- Tests are isolated via `it.instance`; each test gets its own in-memory SQLite DB.
- Critical behaviors to know:
  - Duplicate `prompt_hash` records are both stored (index removed).
  - Sliding window (5s) dedup skips duplicate tool calls.
  - Duplicate-insert warnings are rate-limited (none emitted in test).
  - Abandonment detection reduces prior record confidence by 0.10.
- Run from package dir: `bun test src/adaptive.test.ts`.

## Debugging
- Set `debug: true` in plugin config to see internal logs.
- Or set `OPENCODE_LOG_LEVEL=debug` for OpenCode-wide debug output.
- All raw `console.log` calls are gated by `debugMode`; silent in production.

## Architecture
- Hooks: `tool.execute.after`, `chat.message`, `flush`.
- Tools: `adaptive_record`, `adaptive_trends`, `adaptive_status`, `adaptive_export`, `adaptive_reset`.
- Deduplication: sliding window (5s) via `RecentOpsCache`; SQLite `INSERT OR IGNORE` for explicit records with same `(prompt_hash, tool_name, exit_code)`.
- Rate limiting: duplicate warnings at most once per 60s per key.
- `RecentOpsCache`: TTL 2h, cleanup every 60s.
- Abandonment: new `chat.message` with different `sessionID` reduces prior record confidence by 0.10.
- `flush` hook: does **not** clear timers; if you add intervals, clear them in `flush`.

## Gotchas
- `adaptive_reset` runs `VACUUM` only with `--force`; otherwise just deletes records.
- `duplicateWarningTimestamps` map grows indefinitely; consider periodic cleanup in long-running processes.
- DB file is created in the OpenCode working directory, not the plugin directory.
- Plugin version (`0.1.0`) is independent of OpenCode version.

## Files
- `src/adaptive.ts` — plugin entry, hooks, tools.
- `src/db.ts` — schema, queries, rate limiter.
- `src/observer.ts` — confidence computation.
- `src/adaptive.test.ts` — test suite.
- `README.md` — user-facing docs.

## Development Notes
- Workspace package depending on `@opencode-ai/plugin`.
- When adding Effect code, prefer `Effect.fnUntraced`.
- Never use `unbounded` concurrency; bound to 5/8/10/20.
