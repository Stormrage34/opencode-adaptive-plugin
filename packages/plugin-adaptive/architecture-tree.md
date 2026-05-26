# Adaptive Plugin v2.1.3 — Architecture Reference

**Status:** Production-Ready  
**Last Updated:** 2026-05-26  
**Version:** v2.1.2 baseline

---

## Executive Summary

The Adaptive Plugin is a passive observer that harvests implicit signals from tool executions and stores them in a local SQLite database. It provides trend analysis, confidence scoring, and abandonment detection without interfering with host orchestration.

**Key Properties:**
- Non-blocking: All I/O is synchronous but fast (<0.5ms per INSERT)
- Memory-safe: Bounded caches with TTL eviction
- Secure: Parameterized queries, validated inputs, rate-limited warnings
- Observable: Internal metrics via `adaptive_metrics` tool

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         OpenCode Core (Host)                           │
├─────────────────────────────────────────────────────────────────────────┤
│  Hooks Registered by AdaptivePlugin:                                   │
│    • tool.execute.after  ←─ captures every tool execution             │
│    • chat.message        ←─ session context & abandonment detection   │
│    • flush               ←─ cleanup on shutdown                       │
└─────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                       AdaptivePlugin (Entry)                           │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ State (per plugin instance):                                     │  │
│  │   • db: Database (SQLite WAL)                                    │  │
│  │   • sessionCtx: Map<sessionID, {ctx, ts, lastRecordId}>         │  │
│  │   • recentOps: RecentOpsCache (5s sliding window)               │  │
│  │   • duplicateWarningTimestamps: Map<key, ts> (rate-limit)       │  │
│  │   • timers: TTL cleanup, dup cleanup, recentOps cleanup        │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
                                   │
                    ┌──────────────┴──────────────┐
                    ▼                             ▼
        ┌─────────────────────┐   ┌─────────────────────────┐
        │   chat.message      │   │  tool.execute.after    │
        │   (Session Context) │   │  (Auto-Observer)       │
        └─────────────────────┘   └─────────────────────────┘
                    │                             │
                    │ stores/updates              │ computes confidence
                    ▼                             ▼
        ┌─────────────────────┐   ┌─────────────────────────┐
        │  sessionCtx Map      │   │   observe()             │
        │  + abandonment      │   │   • computeBaseConf()   │
        │    penalty update   │   │   • writeRecord()       │
        └─────────────────────┘   │   • queueMicrotask()    │
                                   │     (validation update) │
                                   └─────────────────────────┘
                                            │
                                            ▼
                                   ┌─────────────────────┐
                                   │   writeRecord()     │
                                   │   (db.ts)           │
                                   └─────────────────────┘
                                            │
                                            ▼
                                   ┌─────────────────────┐
                                   │   SQLite            │
                                   │   telemetry_v2      │
                                   └─────────────────────┘
                                            │
        ┌───────────────────────────────────┼─────────────────────────────┐
        │                                   │                             │
        ▼                                   ▼                             ▼
┌───────────────────┐           ┌───────────────────┐       ┌──────────────────┐
│  Indexes:         │           │  Queries:         │       │  Tools:          │
│  • idx_trends_agg │           │  • queryStats()   │       │  • adaptive_     │
│    (agent, tool,  │           │  • queryRecent()  │       │    record        │
│    confidence,    │           │  • queryTrends()  │       │  • adaptive_     │
│    timestamp)     │           │                   │       │    status        │
│  • idx_telemetry_ │           └───────────────────┘       │  • adaptive_     │
│    v2_ts          │                                        │    export        │
│  • idx_telemetry_ │                                        │  • adaptive_     │
│    v2_task        │                                        │    reset         │
└───────────────────┘                                        │  • adaptive_     │
                                                             │    trends        │
                                                             │  • adaptive_     │
                                                             │    metrics       │
                                                             └──────────────────┘
```

---

## Internal Components

### RecentOpsCache (`recent-ops-cache.ts`)

O(1) TTL cache with doubly-linked list for FIFO eviction.

- **Purpose:** Sliding window deduplication (5s)
- **Key:** `sessionID:toolName`
- **Operations:**
  - `get(key)`: returns timestamp or `undefined`
  - `set(key, ts)`: inserts or updates, moves to tail
  - `cleanup()`: evicts stale entries from head until fresh timestamp
- **Complexity:** O(1) per operation, O(n) cleanup where n = stale entries

### Metrics Counters (`metrics.ts`)

In-memory counters for observability (exposed via `adaptive_metrics` tool):

```typescript
{
  totalInserted: number;
  duplicateAttempts: number;
  duplicateWarnings: number;
  ttlCleanupRuns: number;
  ttlRecordsDeleted: number;
  queryStatsCalls: number;
  queryRecentCalls: number;
  queryTrendsCalls: number;
}
```

### cleanupSessions() (`adaptive.ts`)

Called by TTL timer every 30 minutes.

- Iterates `sessionCtx` Map
- Deletes entries where `now - ts > SESSION_TTL` (2 hours)
- Burst limit: 500 deletions per tick
- Returns count of deleted sessions

---

## Data Flow Timeline

### 1. Session Start

```
chat.message({sessionID, agent, model})
  │
  ▼
sessionCtx.set(sessionID, {ctx: {model, agent}, ts: now})
  │
  └─► Abandonment check:
      if another recent session exists (within 5min):
        UPDATE telemetry_v2
        SET confidence = MAX(0, confidence - 0.10)
        WHERE id = priorSession.lastRecordId
```

### 2. Tool Execution

```
tool.execute.after({tool, sessionID, args}, {output, metadata})
  │
  ├─► recentOps.get(dedupKey)
  │     └─► if timestamp within 5s → SKIP
  │
  ├─► recentOps.set(dedupKey, now)
  │
  ├─► sessionCtx.get(sessionID) → ctx (touch ts)
  │
  ├─► computeBaseConfidence(exitCode, duration)
  │       base=0.5 + (success? +0.35 : -0.40) + (timeout? -0.25)
  │
  ├─► observe() → writeRecord() → INSERT (sync, <0.5ms)
  │       returns rowId
  │
  ├─► sessionCtx[sessionID].lastRecordId = rowId
  │
  └─► queueMicrotask(() => {
          valScore = validateOutput(output)
          if (valScore < 0.5) {
            UPDATE telemetry_v2
            SET confidence = confidence - 0.15,
                signal_json = ?
            WHERE id = rowId
          }
        })
```

### 3. Query Operations

- **adaptive_status** → `queryStats()`
  - `COUNT(*)`, `AVG(confidence)`, `GROUP BY agent/tool`
  - Uses indexes: `idx_telemetry_v2_ts`, `idx_agent_tool_conf`

- **adaptive_recent** → `queryRecent(limit)`
  - `SELECT * ORDER BY id DESC LIMIT ?`
  - Uses index: `idx_telemetry_v2_ts`

- **adaptive_trends** → `queryTrends({groupBy, limit})`
  - Step 1: `SELECT group, COUNT(*) FROM telemetry_v2 WHERE group IS NOT NULL GROUP BY group ORDER BY cnt DESC LIMIT ?`
    - Uses composite index `idx_trends_agg` (covers group + order)
  - Step 2: For each group, `SELECT confidence, id FROM telemetry_v2 WHERE group = ? ORDER BY id DESC LIMIT 100`
    - Uses same composite index (covering index)

### 4. Shutdown

```
flush() → closeDb(db)
  • SQLite connection close
  • WAL checkpoint on next open
```

---

## Database Schema v2

```sql
CREATE TABLE telemetry_v2 (
  id            INTEGER PRIMARY KEY,
  task_id       TEXT,
  model         TEXT,
  agent         TEXT,
  tool_name     TEXT,
  tokens_in     INTEGER DEFAULT 0,
  tokens_out    INTEGER DEFAULT 0,
  exit_code     INTEGER DEFAULT 0,
  confidence    REAL DEFAULT 0.5,
  signal_json   TEXT DEFAULT '{}',
  prompt_hash   TEXT,
  timestamp     DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_telemetry_v2_task   ON telemetry_v2(task_id);
CREATE INDEX idx_telemetry_v2_conf  ON telemetry_v2(confidence);
CREATE INDEX idx_telemetry_v2_ts    ON telemetry_v2(timestamp);
CREATE INDEX idx_agent_tool_conf   ON telemetry_v2(agent, tool_name, confidence);
CREATE INDEX idx_trends_agg        ON telemetry_v2(agent, tool_name, confidence, timestamp);
```

**⚠️ Audit Finding:** `idx_agent_tool_conf` is redundant; `idx_trends_agg` covers all trend/stats queries. Drop to improve INSERT throughput by ~5-8%.

---

## Tool Contracts (JSON I/O)

| Tool | Input | Output |
|------|-------|--------|
| `adaptive_record` | `{ confidence, tool_name?, agent?, model?, prompt? }` | `{ recorded: true, confidence: "0.85" }` |
| `adaptive_status` | `{ recent?: boolean, plain?: boolean }` | `{ stats: { totalRecords, avgConfidence, recordsByConfidence, recordsByAgent, recordsByTool }, recent?: [...] }` or plain text |
| `adaptive_export` | `{ format?: "json"\|"csv", limit?: number, all?: boolean }` | JSON array or CSV string (capped at 50,000 rows) |
| `adaptive_reset` | `{ force?: boolean }` | `"Telemetry cleared. (VACUUM skipped)"` or `"... (VACUUM sync)"` |
| `adaptive_trends` | `{ groupBy: "agent"\|"tool"\|"model", limit?: number }` | `[ { group, trend: "up"\|"down"\|"flat", samples, avgConfidence, recent: [...] }, ... ]` or `"No trend data available..."` |
| `adaptive_metrics` | `{}` | `{ totalInserted, duplicateAttempts, duplicateWarnings, ttlCleanupRuns, ttlRecordsDeleted, queryStatsCalls, queryRecentCalls, queryTrendsCalls }` |

---

## Security & Performance Guarantees

### Security
- **SQL Injection Prevention:** All queries use parameterized bindings; `groupBy` validated against whitelist
- **Rate Limiting:** Duplicate insert warnings ≤1 per 60s per key
- **Logging:** All debug logs gated by `debugMode` flag; no PII in telemetry

### Performance
- **Sync Path:** INSERT completes in <0.5ms, no `await`
- **Async Path:** Validation via `queueMicrotask` (non-blocking)
- **Indexing:** Composite `idx_trends_agg` enables queryTrends latency ~2ms @ 5k rows
- **Deduplication:** O(1) RecentOpsCache, 5s window, 60s cleanup
- **TTL:** Burst-limited (≤500/tick), all timers `.unref()` to not block exit

### Memory Safety
- `sessionCtx`: bounded by TTL (2h) + periodic cleanup (30min)
- `recentOps`: O(n) where n = operations in 5s window (typically <1000)
- `duplicateWarningTimestamps`: hourly cleanup
- All timers: `.unref()` to allow process exit

---

## Validation Checklist

- ✅ All timers use `.unref()` to not block process exit
- ✅ No `console.log` in hot path (gated by `debugMode`)
- ✅ Parameterized queries prevent SQL injection
- ✅ Composite index `idx_trends_agg` verified (2ms @ 5k rows)
- ✅ 20/20 unit tests passing (includes coverage tests)
- ✅ Typecheck clean for plugin code
- ✅ Metrics tool returns valid counters
- ✅ RecentOpsCache unit tested (eviction, timestamp update)
- ✅ `cleanupSessions` unit tested (TTL eviction, burst limit)

### Pending (from audit)
- [ ] Drop `idx_agent_tool_conf` (P0)
- [ ] Cap abandonment penalty at -0.10 + gate on `confidence > 0.65` (P0)
- [ ] Ensure `flush` drains microtasks (P1)

---

## Change Log

| Version | Date | Changes |
|---------|------|---------|
| v2.1.2 | 2026-05-26 | Batches A/B/C: bug fixes, performance, security, metrics, test coverage |
| v2.0.0 | 2025-12-15 | Initial v2 release (passive observer, no state.json) |

---

*For questions or issues, refer to `packages/plugin-adaptive/` source code.*
