// Telemetry Database v2 — SQLite + WAL, auto-observer storage
// No state.json, no plugin state — pure event log

import { Database } from "bun:sqlite"
import { metrics } from "./metrics.js"

// Map to rate‑limit duplicate‑insert warnings (keyed by toolName‑exitCode‑promptHash)
const duplicateWarningTimestamps = new Map<string, number>();

export interface TelemetryRecord {
  taskId: string
  model?: string
  agent?: string
  toolName?: string
  tokensIn: number
  tokensOut: number
  exitCode: number
  confidence: number          // 0.0-1.0 from observer
  signalJson: string          // JSON blob of signal flags
  promptHash?: string         // SHA256 prefix for deduplication
}



export function createTelemetryDb(dbPath: string): Database | null {
  try {
    const db = new Database(dbPath)
    db.run("PRAGMA journal_mode=WAL;")
    db.run("PRAGMA synchronous=NORMAL;")
    db.run("PRAGMA busy_timeout=5000;")
    // Ensure any legacy dedup index is removed before (re)creating the schema
    db.run(`
      DROP INDEX IF EXISTS idx_telemetry_v2_dedup;
      CREATE TABLE IF NOT EXISTS telemetry_v2 (
        id INTEGER PRIMARY KEY,
        task_id TEXT,
        model TEXT, agent TEXT, tool_name TEXT,
        tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0,
        exit_code INTEGER DEFAULT 0,
        confidence REAL DEFAULT 0.5,
        signal_json TEXT DEFAULT '{}',
        prompt_hash TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_telemetry_v2_task ON telemetry_v2(task_id);
      CREATE INDEX IF NOT EXISTS idx_telemetry_v2_conf ON telemetry_v2(confidence);
      CREATE INDEX IF NOT EXISTS idx_telemetry_v2_ts ON telemetry_v2(timestamp);
      -- Composite index for fast trends queries (covers group + ordering)
      CREATE INDEX IF NOT EXISTS idx_trends_agg ON telemetry_v2(agent, tool_name, confidence, timestamp);
    `)
    return db
  } catch (err) {
    metrics.dbErrors++
    console.warn("[db] Failed to initialize SQLite:", err)
    return null
  }
}

// Write a record synchronously. Returns lastInsertRowid for async validation updates.
export function writeRecord(db: Database | null, rec: TelemetryRecord): number | bigint | null {
  if (!db) return null
  try {
      try {
        const result = db.run(
          `INSERT INTO telemetry_v2 (task_id, model, agent, tool_name, tokens_in, tokens_out, exit_code, confidence, signal_json, prompt_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          rec.taskId,
          rec.model ?? null,
          rec.agent ?? null,
          rec.toolName ?? null,
          rec.tokensIn,
          rec.tokensOut,
          rec.exitCode,
          rec.confidence,
          rec.signalJson,
          rec.promptHash ?? null,
        )
        metrics.totalInserted++
        return result.lastInsertRowid ?? null
      } catch (err) {
        // Duplicate (or other) constraint violation – ignore silently
        // Rate‑limit duplicate‑insert warnings to avoid log spam (once per 60 s per key)
        const dupKey = `${rec.toolName ?? ''}-${rec.exitCode ?? ''}-${rec.promptHash ?? ''}`
        metrics.duplicateAttempts++
        const now = Date.now()
        const last = duplicateWarningTimestamps.get(dupKey) ?? 0
        if (now - last > 60_000) {
          console.warn("[db] INSERT failed (likely duplicate)", rec)
          duplicateWarningTimestamps.set(dupKey, now)
          metrics.duplicateWarnings++
        }
        return null
      }
  } catch (err) {
    metrics.dbErrors++
    console.warn("[db] Write failed:", err)
    return null
  }
}

export interface TelemetryStats {
  totalRecords: number
  avgConfidence: number
  recordsByConfidence: { high: number; medium: number; low: number }
  recordsByAgent: Record<string, number>
  recordsByTool: Record<string, number>
}

export function queryStats(db: Database | null): TelemetryStats | null {
  if (!db) return null
  metrics.queryStatsCalls++
  try {
    const total = db.query("SELECT COUNT(*) as c FROM telemetry_v2").get() as { c: number }
    const avg = db.query("SELECT AVG(confidence) as a FROM telemetry_v2").get() as { a: number | null }
    const high = db.query("SELECT COUNT(*) as c FROM telemetry_v2 WHERE confidence >= 0.7").get() as { c: number }
    const medium = db.query("SELECT COUNT(*) as c FROM telemetry_v2 WHERE confidence >= 0.4 AND confidence < 0.7").get() as { c: number }
    const low = db.query("SELECT COUNT(*) as c FROM telemetry_v2 WHERE confidence < 0.4").get() as { c: number }
    const byAgent = db.query("SELECT agent, COUNT(*) as c FROM telemetry_v2 WHERE agent IS NOT NULL GROUP BY agent ORDER BY c DESC").all() as Array<{ agent: string; c: number }>
    const byTool = db.query("SELECT tool_name, COUNT(*) as c FROM telemetry_v2 WHERE tool_name IS NOT NULL GROUP BY tool_name ORDER BY c DESC").all() as Array<{ tool_name: string; c: number }>

    const agents: Record<string, number> = {}
    for (const row of byAgent) agents[row.agent] = row.c
    const tools: Record<string, number> = {}
    for (const row of byTool) tools[row.tool_name] = row.c

    return {
      totalRecords: total.c,
      avgConfidence: avg.a ?? 0,
      recordsByConfidence: { high: high.c, medium: medium.c, low: low.c },
      recordsByAgent: agents,
      recordsByTool: tools,
    }
  } catch { metrics.dbErrors++; return null }
}

export function queryRecent(db: Database | null, n = 20): Array<Record<string, unknown>> {
  if (!db) return []
  metrics.queryRecentCalls++
  try {
    return db.query(
      "SELECT id, task_id, model, agent, tool_name, confidence, exit_code, timestamp FROM telemetry_v2 ORDER BY id DESC LIMIT ?",
    ).all(n) as Array<Record<string, unknown>>
  } catch { metrics.dbErrors++; return [] }
}

export interface ToolStats {
  totalCalls: number
  successRate: number  // 0-1, based on exit_code = 0
  avgConfidence: number // 0-1
}

/** Query per-tool reliability stats for tool.definition enrichment */
export function queryToolStats(db: Database | null, toolName: string): ToolStats | null {
  if (!db) return null
  metrics.queryToolStatsCalls++
  try {
    const result = db.query(`
      SELECT
        COUNT(*) as total_calls,
        AVG(CASE WHEN exit_code = 0 THEN 1.0 ELSE 0.0 END) as success_rate,
        AVG(confidence) as avg_confidence
      FROM telemetry_v2
      WHERE tool_name = ?
        AND timestamp > datetime('now', '-7 days')
    `).get(toolName) as { total_calls: number; success_rate: number | null; avg_confidence: number | null }
    if (!result || result.total_calls === 0) return null
    return {
      totalCalls: result.total_calls,
      successRate: result.success_rate ?? 0,
      avgConfidence: result.avg_confidence ?? 0,
    }
  } catch {
    metrics.dbErrors++
    return null
  }
}

export function exportRecords(db: Database | null, format: "json" | "csv" = "json", limit = 10000): string {
  if (!db) return "[]"
  try {
    const rows = db.query("SELECT * FROM telemetry_v2 ORDER BY id ASC LIMIT ?").all(limit) as Array<Record<string, unknown>>
    if (format === "csv") {
      if (rows.length === 0) return "no data"
      const headers = Object.keys(rows[0]).join(",")
      const lines = rows.map(r => Object.values(r).map(v => typeof v === "string" ? `"${v.replace(/"/g, '""')}"` : String(v)).join(","))
      return [headers, ...lines].join("\n")
    }
    return JSON.stringify(rows, null, 2)
  } catch { metrics.dbErrors++; return "[]" }
}

export function clearRecords(db: Database | null): void {
  if (!db) return
  try {
    db.run("DELETE FROM telemetry_v2")
  } catch { metrics.dbErrors++; /* ignore */ }
}

export function vacuumDb(db: Database | null): void {
  if (!db) return
  try { db.run("VACUUM")   } catch { metrics.dbErrors++; /* ignore */ }
}

export function closeDb(db: Database | null): void {
  if (!db) return
  try { db.close() } catch { /* ignore */ }
}

export interface TrendResult {
  group: string
  avgConfidence: number
  count: number
  trend: "up" | "down" | "flat"
}

/**
 * Query confidence trends by agent, tool, or model.
 * Uses id as a time proxy (auto-increment). Fetches up to 100 most recent records per group.
 */
export function queryTrends(
  db: Database | null,
  options: { groupBy: "agent" | "tool" | "model"; limit?: number }
): TrendResult[] {
  if (!db) return []
  metrics.queryTrendsCalls++
  const { groupBy, limit = 20 } = options
  // Validate groupBy to prevent SQL injection
  if (!["agent", "tool", "model"].includes(groupBy)) return []

  // Map groupBy to actual column name
  const column = groupBy === "tool" ? "tool_name" : groupBy // "agent" | "tool_name" | "model"

   // Step 1: Get top groups by total count
   let groups: Array<{ grp: string; cnt: number }> = []
   try {
      groups = db.query(
        `SELECT ${column} as grp, COUNT(*) as cnt FROM telemetry_v2 WHERE ${column} IS NOT NULL GROUP BY ${column} ORDER BY cnt DESC LIMIT ?`
      ).all(limit) as Array<{ grp: string; cnt: number }>
   } catch (e) {
     metrics.dbErrors++
     console.warn("[db] queryTrends groups query failed", e)
     return []
   }

  const results: TrendResult[] = []

  for (const g of groups) {
    // Fetch up to 100 most recent records for this group (by id descending)
    let records: Array<{ confidence: number; id: number }> = []
     try {
        records = db.query(
          `SELECT confidence, id FROM telemetry_v2 WHERE ${column} = ? ORDER BY id DESC LIMIT 100`
        ).all(g.grp) as Array<{ confidence: number; id: number }>
     } catch (e) {
       metrics.dbErrors++
       console.warn("[db] queryTrends records query failed for group", g.grp, e)
       continue
     }

    if (records.length < 2) continue

    // Reverse to chronological order (oldest first)
    const chronological = records.reverse()
    const confidences = chronological.map(r => r.confidence)
    const avg = confidences.reduce((a, b) => a + b, 0) / confidences.length

    // Compute trend: compare average of first 3 vs last 3
    const n = Math.min(3, Math.floor(chronological.length / 2))
    const firstAvg = confidences.slice(0, n).reduce((a, b) => a + b, 0) / n
    const lastAvg = confidences.slice(-n).reduce((a, b) => a + b, 0) / n
    const diff = lastAvg - firstAvg

    let trend: "up" | "down" | "flat" = "flat"
    if (diff > 0.1) trend = "up"
    else if (diff < -0.1) trend = "down"

    results.push({ group: g.grp, avgConfidence: avg, count: g.cnt, trend })
  }

  return results
}

export interface FailingToolHint {
  toolName: string
  totalCalls: number
  failedCalls: number
  avgConfidence: number
}

/** Query tools with confidence < 0.5 in the last 7 days, for cross-session hints */
export function queryFailingTools(db: Database | null, limit = 3): FailingToolHint[] {
  if (!db) return []
  try {
    return db.query(`
      SELECT
        tool_name as toolName,
        COUNT(*) as totalCalls,
        SUM(CASE WHEN exit_code != 0 THEN 1 ELSE 0 END) as failedCalls,
        ROUND(AVG(confidence), 2) as avgConfidence
      FROM telemetry_v2
      WHERE timestamp > datetime('now', '-7 days')
        AND tool_name IS NOT NULL
      GROUP BY tool_name
      HAVING avgConfidence < 0.5
      ORDER BY failedCalls DESC
      LIMIT ?
    `).all(limit) as FailingToolHint[]
  } catch {
    metrics.dbErrors++
    return []
  }
}

