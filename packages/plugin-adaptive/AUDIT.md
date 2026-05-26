# Adaptive Plugin v2 — Audit

**Version:** 2.0.0 (passive observer)
**Date:** 2026-05-25
**Status:** Production-ready

---

## File Inventory

| File | Lines | Purpose |
|------|-------|---------|
| `src/adaptive.ts` | 232 | Plugin entry point — 5 tools, 2 hooks |
| `src/db.ts` | 145 | SQLite v2 telemetry — WAL, `telemetry_v2` table |
| `src/observer.ts` | 128 | Signal computation from tool execution |
| `src/adaptive.test.ts` | 138 | 10 smoke tests |
| `src/index.ts` | 5 | Re-export |
| Total | 648 | Down from ~1255 (v1), -48% code |

---

## Per-File Audit

### `src/adaptive.ts` — Plugin (232 lines)

**Hooks:**
| Hook | Status | Purpose |
|------|--------|---------|
| `chat.message` | ✅ Works | Stores session context (model, agent) for downstream observer. No mutations. |
| `tool.execute.after` | ✅ Works | Auto-observer fires here. Computes confidence from exit code + output validation. Writes to SQLite. |

**Removed from v1:**
- `chat.params` hook (was clamping maxOutputTokens — interfered with orchestrator)
- `event` hook (EventV2 — user doesn't run with flag)
- state.json persistence, EMA, composite reward, resolveStrategy
- budget checking, model pricing, dispatch recommendation
- ~1080 lines of dead code

**Tools:**
| Tool | Status | Description |
|------|--------|-------------|
| `adaptive_record` | ✅ Works | Manual feedback fallback. Computes signal from confidence value. |

| `adaptive_status` | ✅ Works | Telemetry readout. Supports both JSON (`recent` flag) and plain text (`plain` flag). |
| `adaptive_export` | ✅ Works | Exports all DB records as JSON or CSV. Signal data in `signal_json` column. |
| `adaptive_reset` | ✅ Works | Clears all telemetry records. Runs VACUUM after delete. |

**Config options:**
```typescript
{
  "dbPath"?: string,        // Default: .opencode_telemetry.db
  "debug"?: boolean,        // Default: false
}
```

**Gaps:**
- `tokensIn`/`tokensOut` set to 0 in observer — SDK doesn't expose token counts in `tool.execute.after`
- Strategy advice from 8B not wired to observer (commented out in `tool.execute.after` — async classification would block sync write)
- No debounce on writes — every tool execution fires a synchronous SQLite write

**Hardening (v2.1):**
- `sessionCtx` TTL: 2hr expiry, 30min cleanup interval via `setInterval`. Timer unref'd to not block process exit. Entry timestamp touched on access to extend TTL.

---

### `src/db.ts` — Telemetry Database (145 lines)

**Schema:**
```sql
CREATE TABLE telemetry_v2 (
  id INTEGER PRIMARY KEY,
  task_id TEXT NOT NULL,
  prompt_hash TEXT,
  model TEXT,
  agent TEXT,
  tool_name TEXT,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  exit_code INTEGER DEFAULT 0,
  confidence REAL DEFAULT 0.5,
  signal_json TEXT DEFAULT '{}',
  strategy_advised TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

**Indexes:**
- `idx_telemetry_v2_task` — on `task_id`
- `idx_telemetry_v2_conf` — on `confidence`
- `idx_telemetry_v2_ts` — on `timestamp`

**PRAGMAs:** WAL, synchronous=NORMAL, busy_timeout=5000

**Functions:**
| Function | Status | Notes |
|----------|--------|-------|
| `createTelemetryDb` | ✅ Works | Creates DB + table + indexes. Returns null on failure. |
| `writeRecord` | ✅ Works | Synchronous insert. Null-safe on all optional columns. |
| `queryStats` | ✅ Works | Total count, avg confidence, distribution by confidence/agent/tool. |
| `queryRecent` | ✅ Works | Last N records (default 20). |
| `exportRecords` | ✅ Works | Full table as JSON or CSV. CSV handles string escaping. |
| `clearRecords` | ✅ Works | DELETE + VACUUM. |
| `closeDb` | ✅ Works | Null-safe close. |

**Gaps:**
- No deduplication by `task_id` — repeating the same task creates a new record each time
- `VACUUM` in `clearRecords` may be slow on large datasets
- No composite index on `(agent, tool_name, confidence)` for the stats queries that group by agent+tool

---

### `src/observer.ts` — Signal Computation (128 lines)

**Signal weights:**
| Signal | Weight | Trigger |
|--------|--------|---------|
| `tool_success` | +0.35 | exitCode === 0 |
| `tool_failed` | -0.40 | exitCode !== 0 |
| `validation_pass` | +0.15 | Output passes structural checks (score ≥ 0.8) |
| `parse_fail` | -0.15 | Output fails structural checks (score < 0.5) |
| `timeout` | -0.25 | durationMs > 30000 |
| `user_accept` | +0.45 | Not wired (no user signal source) |
| `user_reject` | -0.50 | Not wired |
| `user_new` | -0.60 | Not wired |
| `edit_small` | +0.20 | Not wired (requires edit-distance analysis) |

**Algorithm:**
```
confidence = clamp(0.5 + Σ(signals), 0.0, 1.0)
```

Base 0.5 (neutral), then additive adjustments per observed signal. Currently 3 of 9 signals are wired:
- `tool_success`/`tool_failed` from exit code
- `validation_pass`/`parse_fail` from output structure
- `timeout` from duration

**`computeConfidence` — ✅ Works:** Returns `{ confidence, signals }` map.
**`validateOutput` — ✅ Works:** Bracket matching (``` fences), truncation markers, JSON parse attempt.
**`observe` — ✅ Works:** Main entry point. Takes DB, context, result. Writes record.
**`hashPrompt` — ✅ Works:** SHA256 prefix, 16 hex chars via `crypto`.

**Gaps:**
- 6 of 9 signal types are unwired — `user_accept`, `user_reject`, `user_new`, `edit_small` have no data source
- Validation only checks ``` fences, truncation markers, JSON parse — no semantic validation

**Hardening (v2.1):**
- `hashPrompt` upgraded from 32-bit base-36 to SHA256 prefix (16 hex chars via `crypto`)
- Deduplication: SQL unique index on `(prompt_hash, tool_name, exit_code)` + 5s sliding window + periodic cleanup
- Removed dead code: `isDuplicate()` function and `instructor.ts` (118 lines)

---

### `src/adaptive.test.ts` — Tests (138 lines)

**10 tests, all passing:**

| Test | Coverage |
|------|----------|
| factory creates hooks | Plugin instantiation |
| registers 5 tools | Tool inventory |
| status returns stats | DB read path |
| record stores record | DB write path |
| reset clears data | DB cleanup |
| chat.message stores context | Hook fires without crash |
| tool.execute.after records observation | Full observer pipeline (success) |
| tool.execute.after records failure | Full observer pipeline (failure) |
| no chat.params hook | Negative assertion — no mutation hook |
| no event hook | Negative assertion — no EventV2 |

**Gaps:**

- No test for `adaptive_export` (JSON/CSV output)
- No test for multiple sessions / context isolation
- No concurrent write test (WAL behavior)
- All tests use `MINIMAL_CTX` — doesn't test with real plugin SDK input shapes

---

## Runtime Status

| Component | Status | Details |
|-----------|--------|---------|
| llama-server (:8080) | ✅ Running | Meta-Llama-3.1-8B-Instruct-Q4_K_M, 36% VRAM (5.8GB) |
| Plugin in config | ✅ Loaded | Registered in `opencode.jsonc` |

---

## Summary

**510 lines of production code** (adaptive.ts + db.ts + observer.ts + index.ts), 138 lines test, 648 total.

**v2.1 Patches Applied:**
- ✅ `sessionCtx` TTL: 2hr expiry, 30min cleanup, timer unref'd
- ✅ Deduplication: SQL unique index on `(prompt_hash, tool_name, exit_code)` + 5s sliding window + periodic cleanup
- ✅ Dead code removal: deleted `instructor.ts` (118 lines) and unused `isDuplicate()` function
- ✅ Hash upgrade: SHA256 (crypto) replacing 32-bit base-36

**Works:** All 5 tools, 2 hooks, SQLite telemetry, observer signals from tool execution.
**Dead code:** 0 lines (all code is reachable).
**Unwired:** 6 of 9 signal types (no user feedback source), `learning` flag (no schema), async strategy advice (commented out).
**Missing:** Token counts in observer (SDK limitation), write debounce (premature), failure hotspot flags.
