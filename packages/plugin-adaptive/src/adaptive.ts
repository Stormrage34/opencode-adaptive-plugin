// opencode-plugin-adaptive v2.0
// Passive observer — harvests tool execution signals, stores to SQLite.
// No chat.params modification, no EventV2 dependency, no state.json.
// Strategy routing delegated to OMO-Slim.

import { Plugin, tool } from "@opencode-ai/plugin"
import path from "path"
import { createTelemetryDb, queryStats, queryRecent, exportRecords, clearRecords, vacuumDb, closeDb, queryTrends, queryToolStats, queryFailingTools, type Database, type TrendResult } from "./db.js"
import { observe, hashPrompt, type ObserverContext, type ToolResult } from "./observer.js"
import { metrics } from "./metrics.js"
import { RecentOpsCache } from "./recent-ops-cache.js"
import { ToolStatsCache } from "./tool-stats-cache.js"
import type { ObserverContext } from "./observer.js"

// Module-level debug logger
let debugMode = false
const log = (...args: any[]) => {
  if (debugMode) console.log("[adaptive]", ...args)
}

// Session TTL constants
const SESSION_TTL = 2 * 60 * 60 * 1000 // 2 hours
const CLEANUP_BURST_LIMIT = 500

// Per-session state for Phase 2 (hints) and Phase 3 (compaction)
interface SessionState {
  ctx: ObserverContext
  ts: number
  lastRecordId?: number
  hintsDelivered?: boolean
  toolStats?: Map<string, { total: number; failed: number }>
}

// Cleanup stale sessions; returns number of entries deleted
export function cleanupSessions(sessionCtx: Map<string, SessionState>): number {
  const now = Date.now()
  let deleted = 0
  // Copy keys to avoid iterator invalidation from concurrent chat.message writes
  const ids = Array.from(sessionCtx.keys())
  for (const id of ids) {
    const entry = sessionCtx.get(id)
    if (!entry) continue
    if (now - entry.ts > SESSION_TTL) {
      sessionCtx.delete(id)
      deleted++
      if (deleted >= CLEANUP_BURST_LIMIT) break
    }
  }
  return deleted
}

// Plugin

export const AdaptivePlugin: Plugin = async (ctx, options) => {
  const config = options as { dbPath?: string; debug?: boolean; experimentalActive?: boolean; dedupWindow?: number } | undefined

  const dbPath = config?.dbPath || path.join(ctx.directory, ".opencode_telemetry.db")
  debugMode = config?.debug || false
  const experimentalActive = config?.experimentalActive || false

  // Initialize SQLite
  const db = createTelemetryDb(dbPath)
  log("[db] initialized at", dbPath)

  // (pendingValidations removed in favor of fire-and-forget microtasks — telemetry is best-effort)

  // Session context cache — maps sessionID → observer context
  // Populated by chat.message, consumed by tool.execute.after
  // TTL: 2hr, cleanup every 30min (non-blocking with yield)
  const sessionCtx = new Map<string, SessionState>()
  const CLEANUP_INTERVAL = 30 * 60 * 1000 // 30 minutes
  let isCleaning = false
  const TTL = setInterval(async () => {
    if (isCleaning) return
    isCleaning = true
    const deleted = cleanupSessions(sessionCtx)
    metrics.ttlCleanupRuns++
    metrics.ttlRecordsDeleted += deleted
    isCleaning = false
  }, CLEANUP_INTERVAL)
  if (TTL.unref) TTL.unref()

  // Periodic cleanup for duplicateWarningTimestamps to prevent unbounded growth
  const DUP_WARN_CLEANUP = setInterval(() => {
    if (duplicateWarningTimestamps.size === 0) return
    const now = Date.now()
    // Copy keys to avoid iterator invalidation from concurrent writeRecord writes
    const keys = Array.from(duplicateWarningTimestamps.keys())
    for (const key of keys) {
      const ts = duplicateWarningTimestamps.get(key)
      if (ts && now - ts > 3600_000) duplicateWarningTimestamps.delete(key)
    }
  }, 3600_000)
  if (DUP_WARN_CLEANUP.unref) DUP_WARN_CLEANUP.unref()

  // 5s sliding window dedup — tracks (sessionID:toolName) timestamps using an efficient TTL cache
  // Configurable via plugin options for testing
  const DEDUP_WINDOW = config?.dedupWindow ?? 5000
  const recentOps = new RecentOpsCache(DEDUP_WINDOW)

  // Periodic cleanup for recentOps to prevent unbounded growth
  const RECENTOPS_CLEANUP_INTERVAL = 60 * 1000 // 60 seconds
  const recentOpsCleanup = setInterval(() => {
    recentOps.cleanup()
  }, RECENTOPS_CLEANUP_INTERVAL)
  if (recentOpsCleanup.unref) recentOpsCleanup.unref()

  // ── ToolStatsCache — zero-DB-IO enrichment layer ──
  const toolStatsCache = new ToolStatsCache()

  // 30s refresh: query DB for dirty tools and populate cache
  const CACHE_REFRESH_INTERVAL = 30_000
  const cacheRefresher = setInterval(() => {
    const dirty = toolStatsCache.getDirty()
    if (dirty.length === 0) return
    metrics.cacheRefreshRuns++
    for (const toolName of dirty) {
      const stats = queryToolStats(db, toolName)
      if (stats) {
        toolStatsCache.set(toolName, { successRate: stats.successRate, totalCalls: stats.totalCalls })
        metrics.cacheRefreshed++
      }
    }
  }, CACHE_REFRESH_INTERVAL)
  if (cacheRefresher.unref) cacheRefresher.unref()

  // 30s cleanup: evict entries untouched for 60s
  const cacheCleaner = setInterval(() => {
    const evicted = toolStatsCache.cleanup()
    metrics.cacheEvictions += evicted
  }, CACHE_REFRESH_INTERVAL)
  if (cacheCleaner.unref) cacheCleaner.unref()

  // ── Tools ──

  // Manual feedback recording (fallback for auto-observer)
  const recordFeedback = tool({
    description: "Record explicit feedback for a task outcome. Use when the auto-observer signal needs correction.",
    args: {
      task_id: tool.schema.string().optional().describe("Task identifier"),
      prompt: tool.schema.string().optional().describe("Original prompt text"),
      model: tool.schema.string().optional().describe("Model used"),
      agent: tool.schema.string().optional().describe("Agent used"),
      tool_name: tool.schema.string().optional().describe("Tool used"),
      confidence: tool.schema.number().describe("Confidence score (0.0-1.0)"),
      exit_code: tool.schema.number().optional().describe("Exit code (0=success)"),
    },
    async execute(args) {
      const confidence = Math.min(1, Math.max(0, args.confidence))
      observe(db, {
        promptHash: args.prompt ? hashPrompt(args.prompt) : undefined,
        model: args.model,
        agent: args.agent,
      }, {
        toolName: args.tool_name || "manual",
        exitCode: args.exit_code ?? (confidence >= 0.5 ? 0 : 1),
        output: "",
      })
      return JSON.stringify({ recorded: true, confidence: confidence.toFixed(2) })
    },
  })

  // Telemetry status readout
  const status = tool({
    description: "Show telemetry stats, recent records, and observer health.",
    args: {
      recent: tool.schema.boolean().optional().describe("Show recent records"),
      plain: tool.schema.boolean().optional().describe("Return plain text (not JSON)"),
    },
    async execute(args) {
      const stats = queryStats(db)
      const recent = args.recent ? queryRecent(db, 10) : []

      if (args.plain) {
        if (!stats) return "No telemetry data yet."
        const lines = [
          `Telemetry: ${stats.totalRecords} records`,
          `Avg confidence: ${stats.avgConfidence.toFixed(2)}`,
          `  High (≥0.7): ${stats.recordsByConfidence.high}`,
          `  Med (0.4-0.7): ${stats.recordsByConfidence.medium}`,
          `  Low (<0.4): ${stats.recordsByConfidence.low}`,
          `By agent: ${Object.entries(stats.recordsByAgent).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`,
          `By tool: ${Object.entries(stats.recordsByTool).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`,
        ]
        if (recent.length > 0) {
          lines.push("", "Recent:")
          for (const r of recent) {
            lines.push(`  #${r.id} | ${String(r.tool_name || r.agent || "?").padEnd(12)} | conf=${Number(r.confidence).toFixed(2)} | exit=${r.exit_code} | ${r.timestamp}`)
          }
        }
        return lines.join("\n")
      }

      return JSON.stringify({ stats, recent }, null, 2)
    },
  })

  // Export telemetry data
  const EXPORT_HARD_CAP = 50_000
  const exportData = tool({
    description: "Export all telemetry records as JSON or CSV.",
    args: {
      format: tool.schema.enum(["json", "csv"]).optional().describe("Export format (default: json)"),
      limit: tool.schema.number().optional().describe("Max rows (default: 10000)"),
      all: tool.schema.boolean().optional().describe("Export all rows (capped at 50000)"),
    },
    async execute(args) {
      const limit = args.all ? EXPORT_HARD_CAP : (args.limit ?? 10_000)
      if (limit > EXPORT_HARD_CAP) throw new Error(`Export capped at ${EXPORT_HARD_CAP} rows. Use SQLite CLI for full dumps.`)
      return exportRecords(db, (args.format as "json" | "csv") || "json", limit)
    },
  })

   // Reset telemetry
    const reset = tool({
      description: "Clear all telemetry records. VACUUM runs only when --force is supplied.",
      args: {
        force: tool.schema.boolean().optional().describe("Run VACUUM after clear (default: skip)"),
      },
      async execute(args) {
        clearRecords(db)
        if (args.force) {
          vacuumDb(db) // sync, user‑requested
          return "Telemetry cleared. (VACUUM sync)"
        }
        return "Telemetry cleared. (VACUUM skipped)"
      },
    })

   // Trend analysis
   const trends = tool({
     description: "Analyze confidence trends by agent, tool, or model.",
     args: {
       groupBy: tool.schema.enum(["agent", "tool", "model"]).describe("Dimension to group by"),
       limit: tool.schema.number().optional().describe("Max groups to return (default: 20)"),
     },
     async execute(args) {
let result: TrendResult[]
        try {
          result = queryTrends(db, {
            groupBy: args.groupBy as "agent" | "tool" | "model",
            limit: args.limit ?? 20,
          })
        } catch (e) {
          // Return a JSON‑encoded error object so callers can always parse the output
          return JSON.stringify({ error: (e as Error).message })
        }
        if (!result || result.length === 0) {
          return JSON.stringify("No trend data available (need at least 2 records per group).")
        }
        return JSON.stringify(result, null, 2)
      },
    })

    // Internal metrics (for debugging and monitoring)
    const metricsTool = tool({
      description: "Return internal plugin metrics (counters). Debug use only.",
      args: {},
      async execute(args) {
        return JSON.stringify({
          totalInserted: metrics.totalInserted,
          duplicateAttempts: metrics.duplicateAttempts,
          duplicateWarnings: metrics.duplicateWarnings,
          ttlCleanupRuns: metrics.ttlCleanupRuns,
          ttlRecordsDeleted: metrics.ttlRecordsDeleted,
          queryStatsCalls: metrics.queryStatsCalls,
          queryRecentCalls: metrics.queryRecentCalls,
          queryTrendsCalls: metrics.queryTrendsCalls,
          queryToolStatsCalls: metrics.queryToolStatsCalls,
          cacheHits: metrics.cacheHits,
          cacheMisses: metrics.cacheMisses,
          cacheRefreshRuns: metrics.cacheRefreshRuns,
          cacheRefreshed: metrics.cacheRefreshed,
          cacheEvictions: metrics.cacheEvictions,
          hintsDelivered: metrics.hintsDelivered,
          compactionContextsInjected: metrics.compactionContextsInjected,
          abandonmentPenalties: metrics.abandonmentPenalties,
          dbErrors: metrics.dbErrors,
          validationQueueDrops: metrics.validationQueueDrops,
        }, null, 2)
      },
    })

  // ── Hooks ──

    return {
        flush: () => {
          // Clear periodic timers to prevent leaks on plugin reload
          if (TTL) clearInterval(TTL)
          if (DUP_WARN_CLEANUP) clearInterval(DUP_WARN_CLEANUP)
          if (recentOpsCleanup) clearInterval(recentOpsCleanup)
          if (cacheRefresher) clearInterval(cacheRefresher)
          if (cacheCleaner) clearInterval(cacheCleaner)

        // Close DB (validation microtasks are fire-and-forget — telemetry is best-effort)
        closeDb(db)
      },

     tool: {
       adaptive_record: recordFeedback,
       adaptive_status: status,
       adaptive_export: exportData,
       adaptive_reset: reset,
       adaptive_trends: trends,
       adaptive_metrics: metricsTool,
     },

    // Passive context cache — stores session metadata for downstream observer
     async "chat.message"(input, _output) {
       if (!input.sessionID) return

       // Implicit abandonment detection: if another recent session exists, penalize it
      const ABANDONMENT_WINDOW_MS = 5 * 60 * 1000 // 5 minutes
      const ABANDONMENT_PENALTY = 0.10
      const now = Date.now()
      let candidate: { id: string; entry: { ctx: ObserverContext; ts: number; lastRecordId?: number } } | null = null
      for (const [id, entry] of sessionCtx) {
        if (id === input.sessionID) continue
        if (now - entry.ts < ABANDONMENT_WINDOW_MS) {
          if (!candidate || entry.ts > candidate.entry.ts) {
            candidate = { id, entry }
          }
        }
      }
      if (candidate && candidate.entry.lastRecordId != null) {
        // Only penalize if current confidence > 0.65 (avoid stacking on already low confidence)
        // NOTE: params must go to .get(), not .query() (Bun SQLite API requirement)
        const current = db.query(
          "SELECT confidence FROM telemetry_v2 WHERE id = ?"
        ).get(candidate.entry.lastRecordId) as { confidence: number } | null
        if (debugMode) log(`[abandonment] candidate ${candidate.id.slice(0, 8)}… id=${candidate.entry.lastRecordId} conf=${current?.confidence}`)
        if (current && current.confidence > 0.65) {
          db.run(
            "UPDATE telemetry_v2 SET confidence = MAX(0, confidence - ?) WHERE id = ?",
            ABANDONMENT_PENALTY,
            candidate.entry.lastRecordId
          )
          metrics.abandonmentPenalties++
          log(`[abandonment] penalized session ${candidate.id.slice(0, 8)}… confidence -${ABANDONMENT_PENALTY}`)
        }
        sessionCtx.delete(candidate.id)
      }

      // Extract model info
      const model = input.model?.modelID || undefined

       // Store session context for tool.execute.after correlation
        sessionCtx.set(input.sessionID, {
          ctx: {
            model,
            agent: input.agent,
          },
          ts: Date.now(),
          toolStats: new Map(),
        })
       log(`[chat.message] sessionCtx[${input.sessionID.slice(0, 8)}…] model=${model ?? "?"} agent=${input.agent ?? "?"}`)
    },

    // Auto-observer — fires after every tool execution
    async "tool.execute.after"(input, output) {
      // 5s sliding window dedup: skip if same tool called within window
      const dedupKey = `${input.sessionID}:${input.tool}`
      const lastTs = recentOps.get(dedupKey)
      const now = Date.now()
      if (lastTs && (now - lastTs) < DEDUP_WINDOW) {
        if (debugMode) log(`[dedup] skipped ${dedupKey} — ${now - lastTs}ms ago`)
        return
      }
      recentOps.set(dedupKey, now)

        const entry = sessionCtx.get(input.sessionID)
        // Touch entry on access to extend TTL
        if (entry) {
          entry.ts = Date.now()
        }
       const ctx = entry?.ctx || {}
      const exitCode = output.metadata?.error ? 1 : 0

      const result: ToolResult = {
        toolName: input.tool,
        exitCode,
        output: output.output || "",
        metadata: output.metadata as Record<string, unknown> | undefined,
      }

    if (debugMode) console.log('[observer] ctx', ctx)
    const rowId = observe(db, ctx, result)
   if (debugMode) console.log(`[observer] rowId=${rowId}`)

   // Mark tool as dirty in cache so it gets refreshed on next interval
   toolStatsCache.invalidate(input.tool)

   // Track per-session tool stats for compaction enrichment (Phase 3)
   if (entry) {
     if (!entry.toolStats) entry.toolStats = new Map()
     const stat = entry.toolStats.get(input.tool) || { total: 0, failed: 0 }
     stat.total++
     if (exitCode !== 0) stat.failed++
     entry.toolStats.set(input.tool, stat)
   }

        // Store record ID in session context for potential abandonment penalty
        if (entry) {
          if (rowId != null) {
            entry.lastRecordId = rowId
          } else {
            // Record insertion failed – log for debugging (gated by debugMode to avoid spam)
            if (debugMode) console.warn('[adaptive] observe failed to insert record for session', input.sessionID.slice(0, 8))
          }
        }

      // If confidence provided in metadata, update the existing record's confidence
      if (entry?.lastRecordId && output.metadata?.confidence !== undefined) {
        const newConf = Math.min(1, Math.max(0, Number(output.metadata.confidence)))
        db.run("UPDATE telemetry_v2 SET confidence = ? WHERE id = ?", newConf, entry.lastRecordId)
        log(`[confidence] updated record ${entry.lastRecordId} to ${newConf}`)
      }

      if (debugMode) {
        log(`[observer] ${input.tool} exit=${exitCode} session=${input.sessionID.slice(0, 8)}…`)
      }
    },

    // Gated hooks — require experimentalActive: true in config
    ...(experimentalActive ? {
      // Enrich tool descriptions with reliability stats from cache
      "tool.definition"(input: { toolID: string }, output: { description: string; parameters?: any; jsonSchema?: any }): Promise<void> {
        const stats = toolStatsCache.get(input.toolID)
        if (stats && stats.totalCalls >= 5) {
          metrics.cacheHits++
          const pct = Math.round(stats.successRate * 100)
          output.description = `${output.description} [${pct}% success, ${stats.totalCalls} calls]`
          return Promise.resolve()
        }
        // Cold start: query DB directly (first call only)
        if (!stats) {
          metrics.cacheMisses++
          const dbStats = queryToolStats(db, input.toolID)
          if (dbStats && dbStats.totalCalls >= 5) {
            toolStatsCache.set(input.toolID, { successRate: dbStats.successRate, totalCalls: dbStats.totalCalls })
            const pct = Math.round(dbStats.successRate * 100)
            output.description = `${output.description} [${pct}% success, ${dbStats.totalCalls} calls]`
            return Promise.resolve()
          }
          // Populate cache even with zero calls to avoid repeated cold starts
          toolStatsCache.set(input.toolID, {
            successRate: dbStats?.successRate ?? 0,
            totalCalls: dbStats?.totalCalls ?? 0,
          })
        }
        return Promise.resolve()
      },

      // Cross-session hints: inject failing tool patterns into new session system prompt
      "experimental.chat.system.transform"(input: { sessionID?: string; model: any }, output: { system: string[] }): Promise<void> {
        if (!input.sessionID) return Promise.resolve()
        const entry = sessionCtx.get(input.sessionID)
        if (!entry || entry.hintsDelivered) return Promise.resolve()

        const hints = queryFailingTools(db, 3)
        if (hints.length > 0) {
          entry.hintsDelivered = true
          metrics.hintsDelivered++
          const note = "Note: previous sessions had recurring failures—" +
            hints.map(h =>
              `${h.toolName} (${h.failedCalls} fails, ${Math.round((h.totalCalls - h.failedCalls) / h.totalCalls * 100)}% success)`
            ).join("; ")
          output.system.push(note)
          if (debugMode) log(`[hints] injected for session ${input.sessionID.slice(0, 8)}…: ${note}`)
        }
        return Promise.resolve()
      },

      // Session compaction enrichment: preserve tool reliability awareness across compaction
      async "experimental.session.compacting"(input: { sessionID: string }, output: { context: string[]; prompt?: string }): Promise<void> {
        const entry = sessionCtx.get(input.sessionID)
        if (!entry?.toolStats || entry.toolStats.size === 0) return

        // Find tools with >30% failure rate and at least 3 calls (meaningful signal)
        const failing: string[] = []
        for (const [toolName, stat] of entry.toolStats) {
          if (stat.total >= 3 && stat.failed / stat.total > 0.3) {
            failing.push(`${toolName} (${stat.failed}/${stat.total} fails)`)
          }
        }

        if (failing.length > 0) {
          metrics.compactionContextsInjected++
          output.context.push(
            "⚠️ Tool failures this session: " + failing.join("; ")
          )
          if (debugMode) log(`[compaction] context for ${input.sessionID.slice(0, 8)}…: ${failing.join("; ")}`)
        }
      },
    } : {}),
  }
}
