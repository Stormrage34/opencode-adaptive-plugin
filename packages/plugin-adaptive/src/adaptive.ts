// opencode-plugin-adaptive
// Self-improving plugin for OpenCode that adapts strategy based on acceptance rates
// https://github.com/opencode-ai/opencode
// Version: 1.1.0-sqlite-telemetry

import { Plugin, tool } from "@opencode-ai/plugin"
import path from "path"
import fs from "fs/promises"
import { Database } from "bun:sqlite"

// ============================================================================
// Types
// ============================================================================

type Strategy = "fast" | "balanced" | "verified"
type TaskType = "coding" | "reasoning" | "debug"

interface PerTypeMetrics {
  calls: number
  accepts: number
  rejects: number
  avgLatencyMs: number
  avgTokens: number
  lastError?: string
}

interface PluginState {
  activeStrategy: Record<TaskType, Strategy>
  metrics: Record<TaskType, PerTypeMetrics>
  errorWeights: Record<TaskType, Record<string, number>>
  contextBudgetTokens: Record<Strategy, number>
  acceptThreshold: number
  lastAdaptation?: number
  overrides: Record<TaskType, boolean>
  modelPricing: Record<string, { input: number; output: number }>
}

const DEFAULT_STATE: PluginState = {
  activeStrategy: {
    coding: "fast",
    reasoning: "balanced",
    debug: "verified",
  },
  metrics: {
    coding: { calls: 0, accepts: 0, rejects: 0, avgLatencyMs: 0, avgTokens: 0 },
    reasoning: { calls: 0, accepts: 0, rejects: 0, avgLatencyMs: 0, avgTokens: 0 },
    debug: { calls: 0, accepts: 0, rejects: 0, avgLatencyMs: 0, avgTokens: 0 },
  },
  errorWeights: {
    coding: {},
    reasoning: {},
    debug: {},
  },
  contextBudgetTokens: {
    fast: 2048,
    balanced: 3072,
    verified: 4096,
  },
  acceptThreshold: 0.65,
  overrides: {
    coding: false,
    reasoning: false,
    debug: false,
  },
  modelPricing: {
    // Pricing per 1K tokens (USD)
    "qwen3.5-plus": { input: 0.0002, output: 0.0006 },
    "qwen3.5": { input: 0.0001, output: 0.0004 },
    "o4-mini": { input: 0.001, output: 0.003 },
    "claude-sonnet-4": { input: 0.0003, output: 0.0015 },
    "gpt-4o": { input: 0.0005, output: 0.0015 },
  },
}

// ============================================================================
// Classifier (O(1) heuristic)
// ============================================================================

const DEBUG_KEYWORDS = ["error", "exception", "stack", "break", "fails", "failed", "bug", "crash"]
const CODING_KEYWORDS = [
  "syntax",
  "imports",
  "functions",
  "diffs",
  "refactor",
  "implement",
  "test",
  "write",
  "create",
  "add",
  "remove",
  "update",
  "function",
  "class",
  "module",
  "component",
]
const REASONING_KEYWORDS = [
  "explain",
  "design",
  "plan",
  "compare",
  "evaluate",
  "architecture",
  "analyze",
  "review",
  "discuss",
  "why",
  "how",
  "what",
  "understand",
]

function classify(prompt: string): TaskType {
  const lower = prompt.toLowerCase()

  // Debug takes priority - errors need verified strategy
  if (DEBUG_KEYWORDS.some((k) => lower.includes(k))) {
    return "debug"
  }

  // Coding keywords indicate implementation work
  if (CODING_KEYWORDS.some((k) => lower.includes(k))) {
    return "coding"
  }

  // Reasoning keywords indicate analysis/design work
  if (REASONING_KEYWORDS.some((k) => lower.includes(k))) {
    return "reasoning"
  }

  // Default to coding for most CLI tasks
  return "coding"
}

// ============================================================================
// Plugin
// ============================================================================

export const AdaptivePlugin: Plugin = async (ctx, options) => {
  const config = options as { statePath?: string; debug?: boolean; telemetryDb?: string } | undefined
  const statePath = config?.statePath || path.join(ctx.directory, ".opencode_adaptive_state.json")
  const telemetryDbPath = config?.telemetryDb || path.join(ctx.directory, ".opencode_telemetry.db")
  const debug = config?.debug || false
  let state = await loadState(statePath)

  // Initialize SQLite telemetry database with WAL mode for concurrent writes
  let telemetryDb: Database | null = null
  try {
    telemetryDb = new Database(telemetryDbPath)
    telemetryDb.run("PRAGMA journal_mode=WAL;")
    telemetryDb.run("PRAGMA busy_timeout=5000;")
    telemetryDb.run(`
      CREATE TABLE IF NOT EXISTS telemetry (
        id INTEGER PRIMARY KEY,
        task_id TEXT NOT NULL,
        model TEXT NOT NULL,
        tokens_in INTEGER NOT NULL,
        tokens_out INTEGER NOT NULL,
        cost REAL NOT NULL,
        exit_code INTEGER NOT NULL,
        ts DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_telemetry_task_id ON telemetry(task_id);
    `)
    log("[telemetry] SQLite initialized with WAL mode")
  } catch (error) {
    log("[telemetry] Failed to initialize SQLite, falling back to in-memory only:", error)
    telemetryDb = null
  }

  // Async queue for telemetry writes (batch flush: 50 ops or 100ms)
  const telemetryQueue: Array<() => void> = []
  let flushTimer: NodeJS.Timeout | null = null
  const TELEMETRY_BATCH_SIZE = 50
  const TELEMETRY_FLUSH_INTERVAL = 100

  const queueTelemetryWrite = (writeOp: () => void) => {
    telemetryQueue.push(writeOp)
    
    if (telemetryQueue.length >= TELEMETRY_BATCH_SIZE) {
      flushTelemetryQueue()
    } else if (!flushTimer) {
      flushTimer = setTimeout(flushTelemetryQueue, TELEMETRY_FLUSH_INTERVAL)
    }
  }

  const flushTelemetryQueue = () => {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }

    if (telemetryQueue.length === 0 || !telemetryDb) return

    const batch = [...telemetryQueue]
    telemetryQueue.length = 0

    try {
      telemetryDb.transaction(() => {
        for (const writeOp of batch) {
          writeOp()
        }
      })
      log(`[telemetry] Flushed ${batch.length} ops to SQLite`)
    } catch (error) {
      log("[telemetry] Batch flush failed:", error)
      // Re-queue failed ops at the front
      telemetryQueue.unshift(...batch)
    }
  }

  // Flush on process exit
  process.on("beforeExit", () => {
    flushTelemetryQueue()
    if (telemetryDb) {
      telemetryDb.close()
    }
  })

  // Debounce timer for JSON state writes
  let jsonStateTimer: NodeJS.Timeout | null = null

  const log = (...args: any[]) => {
    if (debug) console.log("[adaptive]", ...args)
  }

  // Debounced save - coalesces writes within 10s window
  const scheduleSave = () => {
    if (jsonStateTimer) clearTimeout(jsonStateTimer)
    jsonStateTimer = setTimeout(async () => {
      await saveState(statePath, state)
      jsonStateTimer = null
    }, 10000)
  }

  // Immediate flush (for process exit)
  const flush = async () => {
    if (jsonStateTimer) {
      clearTimeout(jsonStateTimer)
      jsonStateTimer = null
    }
    await saveState(statePath, state)
  }

  // Public API for agents - resolve strategy from prompt
  const resolveStrategy = (prompt: string): Strategy => {
    const type = classify(prompt)
    return state.activeStrategy[type]
  }

  // Internal record function (called by hooks and tools)
  const record = (
    taskType: TaskType,
    accepted: boolean,
    latencyMs: number,
    tokensUsed: number,
    strategyUsed: Strategy,
    error?: string,
  ) => {
    const metrics = state.metrics[taskType]

    metrics.calls += 1
    if (accepted) {
      metrics.accepts += 1
    } else {
      metrics.rejects += 1
    }

    // Running averages
    metrics.avgLatencyMs = ((metrics.calls - 1) * metrics.avgLatencyMs + latencyMs) / metrics.calls
    metrics.avgTokens = ((metrics.calls - 1) * metrics.avgTokens + tokensUsed) / metrics.calls

    if (error) {
      const errorKey = error.split(":")[0].trim()
      state.errorWeights[taskType][errorKey] = (state.errorWeights[taskType][errorKey] || 0) + 1

      // Adapt on repeated errors (≥2 occurrences)
      if (state.errorWeights[taskType][errorKey] >= 2 && !state.overrides[taskType]) {
        const oldStrategy = state.activeStrategy[taskType]
        state.activeStrategy[taskType] = "verified"
        state.contextBudgetTokens.verified = Math.max(
          2000,
          Math.floor(state.contextBudgetTokens.verified * 0.85),
        )
        log(`[${taskType}] Adapted: ${oldStrategy} → verified, budget ${state.contextBudgetTokens.verified}`)
      }
    }

    // Adaptation logic (only if not overridden)
    if (!state.overrides[taskType]) {
      const acceptRate = metrics.accepts / Math.max(1, metrics.calls)
      const threshold = state.acceptThreshold

      // Escalate when accept rate drops below threshold - 0.1
      if (acceptRate < threshold - 0.1 && state.activeStrategy[taskType] !== "verified") {
        const oldStrategy = state.activeStrategy[taskType]
        state.activeStrategy[taskType] = "verified"
        log(`[${taskType}] Escalated: ${oldStrategy} → verified (accept rate ${acceptRate.toFixed(2)})`)
      }

      // Downgrade when accept rate exceeds threshold + 0.15
      if (acceptRate > threshold + 0.15 && state.activeStrategy[taskType] === "verified") {
        state.activeStrategy[taskType] = "balanced"
        log(`[${taskType}] Downgraded: verified → balanced (accept rate ${acceptRate.toFixed(2)})`)
      }
    }

    scheduleSave()
  }

  // Tool to record feedback (mandatory post-execution)
  const recordFeedback = tool({
    description:
      "Record user feedback on a suggestion. MUST be called after every AI suggestion. Call this after accepting or rejecting an AI suggestion.",
    args: {
      task_type: tool.schema.enum(["coding", "reasoning", "debug"]).describe("Task type (auto-detected if omitted)"),
      accepted: tool.schema.boolean().describe("Whether the suggestion was accepted"),
      latency_ms: tool.schema.number().describe("Latency in milliseconds"),
      input_tokens: tool.schema.number().describe("Input/prompt token count"),
      output_tokens: tool.schema.number().describe("Output/completion token count"),
      model: tool.schema.string().describe("Model used (e.g., qwen3.5-plus, o4-mini)"),
      strategy_used: tool.schema.enum(["fast", "balanced", "verified"]).describe("Strategy that was used"),
      task_id: tool.schema.string().optional().describe("Task identifier for tracking"),
      error: tool.schema.string().optional().describe("Error message if the operation failed"),
    },
    async execute(args) {
      const taskType = args.task_type || classify(args.strategy_used || "coding")
      const totalTokens = args.input_tokens + args.output_tokens
      
      // Calculate cost based on model pricing
      const pricing = state.modelPricing[args.model] || state.modelPricing["qwen3.5-plus"]
      const estimatedCost = (args.input_tokens / 1000) * pricing.input + (args.output_tokens / 1000) * pricing.output
      
      // Record to SQLite telemetry (async queue, fire-and-forget)
      const taskId = args.task_id || `task_${Date.now()}`
      const exitCode = args.accepted ? 0 : 1
      
      queueTelemetryWrite(() => {
        telemetryDb!.run(
          "INSERT INTO telemetry (task_id, model, tokens_in, tokens_out, cost, exit_code) VALUES (?, ?, ?, ?, ?, ?)",
          taskId,
          args.model,
          args.input_tokens,
          args.output_tokens,
          estimatedCost,
          exitCode,
        )
      })
      
      log(`[telemetry] Queued: ${taskId} ${args.model} ${totalTokens} tokens $${estimatedCost.toFixed(6)}`)
      
      // Legacy: also record to per-type metrics (for strategy adaptation)
      record(taskType, args.accepted, args.latency_ms, totalTokens, args.strategy_used || "fast", args.error)

      const metrics = state.metrics[taskType]
      const acceptRate = metrics.accepts / Math.max(1, metrics.calls)

      log(`[${taskType}] ${acceptRate.toFixed(2)} accept rate (${metrics.accepts}/${metrics.calls})`)

      return JSON.stringify({
        recorded: true,
        taskType,
        acceptRate: acceptRate.toFixed(2),
        strategy: state.activeStrategy[taskType],
        cost: estimatedCost.toFixed(6),
        totalTokens,
        telemetry: "sqlite",
      })
    },
  })

  // Tool to get current strategy and metrics (per-type breakdown)
  const getStrategy = tool({
    description: "Get the current adaptive strategy and metrics per task type",
    args: {
      reset: tool.schema.boolean().optional().describe("Reset all metrics and state"),
      tokens: tool.schema.boolean().optional().describe("Show token usage and cost statistics"),
    },
    async execute(args) {
      if (args.reset) {
        state = { ...DEFAULT_STATE }
        await flush()
        return "State reset to defaults"
      }

      // Show token stats if requested
      if (args.tokens) {
        if (!telemetryDb) {
          return "Telemetry database not initialized"
        }
        
        // Query aggregate stats from SQLite
        const totals = telemetryDb
          .query("SELECT SUM(tokens_in) as input, SUM(tokens_out) as output, SUM(cost) as total FROM telemetry")
          .get() as { input: number | null; output: number | null; total: number | null }
        
        const totalTokens = (totals.input || 0) + (totals.output || 0)
        const inputTokens = totals.input || 0
        const outputTokens = totals.output || 0
        const totalCost = totals.total || 0
        
        // Accept/reject cost analysis (exit_code: 0=accepted, 1=rejected)
        const acceptedStats = telemetryDb
          .query("SELECT SUM(cost) as cost FROM telemetry WHERE exit_code = 0")
          .get() as { cost: number | null }
        const rejectedStats = telemetryDb
          .query("SELECT SUM(cost) as cost FROM telemetry WHERE exit_code = 1")
          .get() as { cost: number | null }
        
        const acceptedCost = acceptedStats.cost || 0
        const rejectedCost = rejectedStats.cost || 0
        
        // Model breakdown
        const modelRows = telemetryDb
          .query("SELECT model, COUNT(*) as calls, SUM(tokens_in + tokens_out) as tokens, SUM(cost) as cost FROM telemetry GROUP BY model ORDER BY cost DESC")
          .all() as Array<{ model: string; calls: number; tokens: number; cost: number }>
        
        const modelStats: Record<string, { calls: number; tokens: number; cost: number }> = {}
        for (const row of modelRows) {
          modelStats[row.model] = {
            calls: row.calls,
            tokens: row.tokens,
            cost: row.cost,
          }
        }
        
        // Recent logs (last 10)
        const recentRows = telemetryDb
          .query("SELECT task_id, model, tokens_in + tokens_out as tokens, cost, exit_code FROM telemetry ORDER BY id DESC LIMIT 10")
          .all() as Array<{ task_id: string; model: string; tokens: number; cost: number; exit_code: number }>
        
        return JSON.stringify({
          tokenUsage: {
            total: totalTokens,
            input: inputTokens,
            output: outputTokens,
            inputOutputRatio: totalTokens > 0 ? (inputTokens / totalTokens).toFixed(2) : "0.00",
          },
          cost: {
            total: totalCost.toFixed(6),
            accepted: acceptedCost.toFixed(6),
            rejected: rejectedCost.toFixed(6),
            wasteRate: totalCost > 0 ? (rejectedCost / totalCost).toFixed(2) : "0.00",
          },
          byModel: modelStats,
          recentLogs: recentRows.map(row => ({
            taskId: row.task_id,
            model: row.model,
            tokens: row.tokens,
            cost: row.cost.toFixed(6),
            accepted: row.exit_code === 0,
          })),
        }, null, 2)
      }

      const result: Record<TaskType, any> = {} as any
      const totalCalls = Object.values(state.metrics).reduce((sum, m) => sum + m.calls, 0)
      const totalAccepts = Object.values(state.metrics).reduce((sum, m) => sum + m.accepts, 0)

      for (const type of ["coding", "reasoning", "debug"] as TaskType[]) {
        const metrics = state.metrics[type]
        const acceptRate = metrics.calls > 0 ? metrics.accepts / metrics.calls : 0
        result[type] = {
          strategy: state.activeStrategy[type],
          acceptRate: acceptRate.toFixed(2),
          calls: metrics.calls,
          accepts: metrics.accepts,
          rejects: metrics.rejects,
          avgLatencyMs: Math.round(metrics.avgLatencyMs),
          avgTokens: Math.round(metrics.avgTokens),
          overridden: state.overrides[type],
        }
      }

      return JSON.stringify(
        {
          strategies: result,
          aggregate: {
            totalInteractions: totalCalls,
            overallAcceptRate: totalCalls > 0 ? (totalAccepts / totalCalls).toFixed(2) : "0.00",
            threshold: state.acceptThreshold,
            contextBudgets: state.contextBudgetTokens,
            lastAdaptation: state.lastAdaptation ? new Date(state.lastAdaptation).toISOString() : "never",
          },
        },
        null, 2,
      )
    },
  })

  // Tool to manually set strategy (per-type or global)
  const setStrategy = tool({
    description: "Manually set the adaptive strategy (per-type or global override)",
    args: {
      type: tool.schema.enum(["coding", "reasoning", "debug"]).optional().describe("Task type to override"),
      strategy: tool.schema.enum(["fast", "balanced", "verified"]).describe("Strategy to use"),
      global: tool.schema.boolean().optional().describe("Apply to all task types"),
      reset: tool.schema.boolean().optional().describe("Remove override and resume auto-adaptation"),
    },
    async execute(args) {
      if (args.reset) {
        if (args.type) {
          state.overrides[args.type] = false
          return `Override removed for ${args.type}, auto-adaptation resumed`
        }
        // Reset all
        state.overrides = { coding: false, reasoning: false, debug: false }
        return "All overrides removed, auto-adaptation resumed"
      }

      const strategy = args.strategy!

      if (args.global) {
        for (const type of ["coding", "reasoning", "debug"] as TaskType[]) {
          state.activeStrategy[type] = strategy
          state.overrides[type] = true
        }
        await flush()
        return `Global override set to ${strategy} for all task types`
      }

      const type = args.type || "coding"
      state.activeStrategy[type] = strategy
      state.overrides[type] = true
      await flush()
      return `Strategy for ${type} set to ${strategy} (override active)`
    },
  })

  // Periodic RAM tracking (5min interval, debug only)
  if (debug) {
    const ramInterval = setInterval(async () => {
      const mem = process.memoryUsage()
      log(`RAM: heap ${Math.round(mem.heapUsed / 1024 / 1024)}MB, rss ${Math.round(mem.rss / 1024 / 1024)}MB`)
    }, 300000).unref()

    // Cleanup on process exit
    process.on("exit", () => {
      clearInterval(ramInterval)
    })
  }

  // Ensure state is flushed on process exit
  process.on("beforeExit", () => {
    flush()
  })

  return {
    // Public API exposed for agent integration
    resolveStrategy,
    flush,

    tool: {
      adaptive_record: recordFeedback,
      adaptive_strategy: getStrategy,
      adaptive_set: setStrategy,
    },

    // Adjust LLM parameters based on current strategy (per-task-type)
    async "chat.params"(input, output) {
      const prompt = input.prompt || ""
      
      // Skip token limiting for subagents — they need full output budget for comprehensive work
      // Subagents: librarian, explorer, oracle, designer, fixer, general, councillor
      const isSubagent = input.agent && 
        ['librarian', 'explorer', 'oracle', 'designer', 'fixer', 'general', 'councillor'].includes(input.agent)
      
      if (isSubagent) {
        log(`[subagent:${input.agent}] skipping token limit, maxOutputTokens=${output.maxOutputTokens}`)
        return
      }
      
      const taskType = classify(prompt)
      const strategy = state.activeStrategy[taskType]
      const maxTokens = state.contextBudgetTokens[strategy]

      const currentMax = typeof output.maxOutputTokens === "number" ? output.maxOutputTokens : 4096
      output.maxOutputTokens = Math.floor(Math.min(currentMax, maxTokens))
      log(`[${taskType}] ${strategy} strategy, maxOutputTokens=${output.maxOutputTokens}`)
      // Note: Don't return output - modify in place like other plugins
    },

    // Track context size for potential optimization
    async "chat.message"(input, output) {
      const contextSize =
        output.parts?.reduce((sum, p) => sum + (p?.type === "text" && p?.content ? p.content.length : 0), 0) || 0

      const prompt = input.prompt || ""
      const taskType = classify(prompt)
      const strategy = state.activeStrategy[taskType]
      const budget = state.contextBudgetTokens[strategy] * 4

      if (contextSize > budget) {
        log(`[${taskType}] Context ${contextSize} chars exceeds budget ${budget} chars`)
      }
      // Note: Don't return output - modify in place like other plugins
    },
  }
}

// ============================================================================
// State persistence
// ============================================================================

async function loadState(filePath: string): Promise<PluginState> {
  try {
    const content = await fs.readFile(filePath, "utf-8")
    const parsed = JSON.parse(content)

    // Migration: detect old flat format (string) and convert to per-type
    if (typeof parsed.activeStrategy === "string") {
      const oldStrategy = parsed.activeStrategy as string
      parsed.activeStrategy = {
        coding: oldStrategy,
        reasoning: oldStrategy,
        debug: oldStrategy,
      }
    }

    // Migration: rename old strategy names to new names
    // minimal → fast, context_rich → balanced, verified → verified
    const strategyMap: Record<string, Strategy> = {
      minimal: "fast",
      context_rich: "balanced",
      verified: "verified",
      fast: "fast",
      balanced: "balanced",
    }

    if (parsed.activeStrategy && typeof parsed.activeStrategy === "object") {
      for (const type of ["coding", "reasoning", "debug"] as TaskType[]) {
        const oldName = parsed.activeStrategy[type] as string
        if (oldName && strategyMap[oldName]) {
          parsed.activeStrategy[type] = strategyMap[oldName]
        }
      }
    }

    // Ensure all required fields exist
    const migrated: PluginState = {
      ...DEFAULT_STATE,
      ...parsed,
      activeStrategy: {
        ...DEFAULT_STATE.activeStrategy,
        ...parsed.activeStrategy,
      },
      metrics: {
        ...DEFAULT_STATE.metrics,
        ...parsed.metrics,
      },
      errorWeights: {
        ...DEFAULT_STATE.errorWeights,
        ...parsed.errorWeights,
      },
      contextBudgetTokens: {
        ...DEFAULT_STATE.contextBudgetTokens,
        ...parsed.contextBudgetTokens,
      },
      overrides: {
        ...DEFAULT_STATE.overrides,
        ...parsed.overrides,
      },
      modelPricing: {
        ...DEFAULT_STATE.modelPricing,
        ...parsed.modelPricing,
      },
    }

    return migrated
  } catch (error) {
    return { ...DEFAULT_STATE }
  }
}

async function saveState(filePath: string, state: PluginState) {
  state.lastAdaptation = Date.now()
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(state, null, 2))
}
