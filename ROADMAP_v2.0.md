# Adaptive Plugin v2 — Corrected Roadmap

**Version:** 2.0.0 (passive observer)
**Date:** 2026-05-25

## Current Reality Check

| Roadmap Item | Status | Reality |
|-------------|--------|---------|
| v2.1 sessionCtx TTL | ✅ Done | Working, 2hr expiry, 30min cleanup |
| v2.1 Instructor circuit breaker | ❌ Irrelevant | 8B model killed ("too taxing"), circuit breaker for a dead service |
| v2.1 Hash upgrade | ✅ Done | SHA256 via crypto |
| v2.1 Deduplication | ✅ Done | 5s sliding window dedup + periodic cleanup of recentOps (SQL index removed) |
| v2.2 Wire user_accept/reject | ❌ No signal source | No user feedback channel exists |
| v2.2 Async instructor enrichment | ❌ No instructor | 8B is dead |
| v2.3 OMO-Slim integration | ❌ Blocked | Plugin can't write opencode.json |
| v2.4 Learning | ❌ Premature | Zero data to learn from |

**Net:** 3 of 4 v2.1 tasks are done; 1 (async writes) deferred as premature optimization. v2.2+ assumes infrastructure that doesn't exist.

---

## MVP Roadmap — What Actually Delivers Value

### v2.1 — Clean & Harden (~30 min)

Remove dead code, fix data quality, simplify.

| # | Task | Priority | What | Why |
|---|------|----------|------|-----|
| 1 | **Strip instructor.ts** | P0 | ✅ Already removed — file doesn't exist, no references in source. | 148 lines of dead code eliminated. |
| 2 | **Fix `strategyAdvised` no-op** | P0 | ✅ Already removed — no such code in current version. | Cleaned up confusing no-op. |
| 3 | **Add deduplication** | P1 | ✅ Done: SQL unique index on `(prompt_hash, tool_name, exit_code)` + 5s sliding window dedup + periodic cleanup of `recentOps`. | Stops retries from creating noise in telemetry. |
| 4 | **Async writes** | P2 | ⏸️ Deferred — sync INSERT is fast (<0.1ms) and needed for `rowId`; validation already async. Premature optimization. | Would complicate abandonment detection and confidence updates. |

### v2.2 — Telemetry Consumer (~1 hr)

The plugin writes data but never reads it. Add a consumer that makes the data useful.

| # | Task | Priority | What | Why |
|---|------|----------|------|-----|
| 5 | **Confidence trend tool** | P0 | Add `adaptive_trends` — queries SQLite for per-agent, per-tool, per-model confidence averages + trend direction (up/down/flat). | First consumer of telemetry data. Answers "what's working, what's struggling." |
| 6 | **Failure hotspots** | P1 | In the same tool: flag agents/tools with avg confidence < 0.4 or >3 consecutive failures. | Surfaces problems automatically instead of requiring manual DB queries. |

### v2.3 — Session Signals (~1 hr)

Better signal quality from existing hooks.

| # | Task | Priority | What | Why |
|---|------|----------|------|-----|
| 7 | **Wire chat.message as implicit feedback** | P1 | When `chat.message` fires for a new task while a prior sessionCtx entry exists, lower the old entry's confidence slightly (abandoned task = implicit rejection). | 1 of 6 unwired signals becomes active with zero new infrastructure. |
| 8 | **Export format hardening** | P1 | Validate format arg, handle empty DB gracefully, add JSON line-delimited format. | Current export silently returns "[]" on empty DB. |

### v2.4 — Advisory Insights (future)

Proactive recommendations from telemetry.

| # | Task | Priority | What | Why |
|---|------|----------|------|-----|
| 9 | **Startup insight dump** | P2 | On plugin load, log a summary: "Last session: 85% tool success, highest failure on $tool, recommended focus: $area" | First proactive value — user sees it without asking. |
| 10 | **Aggregate > recommend** | P3 | If confidence trend drops below 0.4 for a tool type, suggest via status tool: "Read has 30% failure rate — consider verifying paths before calls." | Turns data into actionable advice. |

---

## What the MVP Does (after v2.3)

```
Tool executes → observer computes confidence → SQLite write  ✅
adaptive_trends → per-agent/tool/model confidence averages   ✅ (NEW)
adaptive_status → telemetry readout                           ✅
adaptive_record → manual fallback                             ✅
adaptive_export → JSON/CSV export                             ✅
adaptive_reset → clear data                                   ✅
Implicit abandonment detection → lower old task confidence    ✅ (NEW)

Total: 5 lean tools, 2 hooks, ~250 lines production code
Dead code: 0 lines
```

## What the MVP Explicitly Does NOT Do

| Feature | Reason |
|---------|--------|
| Change model IDs | SDK limitation — can't |
| Write opencode.json | Plugin can't |
| Real-time adaptation | No EventV2 |
| 8B classification | Model killed, too slow for the value |
| Learning/SFT | Zero data, premature |
| OMO-Slim integration | Config is read-only |

## Current State (before fixes)

- 4 files, 302 lines production code
- ~148 lines dead (instructor.ts + orphaned classify)
- 0 lines that consume telemetry data
- 5 tools, 1 of which always returns failure
