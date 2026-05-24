// opencode-plugin-adaptive
// Self-improving plugin for OpenCode that adapts strategy based on acceptance rates
// https://github.com/opencode-ai/opencode
// Version: 1.0.0-rule-only

import { Plugin, tool } from "@opencode-ai/plugin"
import path from "path"
import fs from "fs/promises"

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
}

// ============================================================================
// Classifier (O(1) heuristic)
// ============================================================================

const DEBUG_KEYWORDS = ["error", "exception", "stack", "break", "fails", "failed", "bug", "fix", "crash"]
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
  const config = options as { statePath?: string; debug?: boolean } | undefined
  const statePath = config?.statePath || path.join(ctx.directory, ".opencode_adaptive_state.json")
  const debug = config?.debug || false
  let state = await loadState(statePath)

  // Debounce timer for state writes
  let flushTimer: NodeJS.Timeout | null = null

  const log = (...args: any[]) => {
    if (debug) console.log("[adaptive]", ...args)
  }

  // Debounced save - coalesces writes within 10s window
  const scheduleSave = () => {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = setTimeout(async () => {
      await saveState(statePath, state)
      flushTimer = null
    }, 10000)
  }

  // Immediate flush (for process exit)
  const flush = async () => {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
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
      tokens_used: tool.schema.number().describe("Input + output token count"),
      strategy_used: tool.schema.enum(["fast", "balanced", "verified"]).describe("Strategy that was used"),
      error: tool.schema.string().optional().describe("Error message if the operation failed"),
    },
    async execute(args) {
      const taskType = args.task_type || classify(args.strategy_used || "coding")
      record(taskType, args.accepted, args.latency_ms, args.tokens_used, args.strategy_used || "fast", args.error)

      const metrics = state.metrics[taskType]
      const acceptRate = metrics.accepts / Math.max(1, metrics.calls)

      log(`[${taskType}] ${acceptRate.toFixed(2)} accept rate (${metrics.accepts}/${metrics.calls})`)

      return JSON.stringify({
        recorded: true,
        taskType,
        acceptRate: acceptRate.toFixed(2),
        strategy: state.activeStrategy[taskType],
      })
    },
  })

  // Tool to get current strategy and metrics (per-type breakdown)
  const getStrategy = tool({
    description: "Get the current adaptive strategy and metrics per task type",
    args: {
      reset: tool.schema.boolean().optional().describe("Reset all metrics and state"),
    },
    async execute(args) {
      if (args.reset) {
        state = { ...DEFAULT_STATE }
        await flush()
        return "State reset to defaults"
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
        null,
        2,
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
    }, 300000)

    // Cleanup on process exit
    process.on("exit", () => {
      clearInterval(ramInterval)
    })
  }

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
      const taskType = classify(prompt)
      const strategy = state.activeStrategy[taskType]
      const maxTokens = state.contextBudgetTokens[strategy]

      const currentMax = typeof output.maxOutputTokens === "number" ? output.maxOutputTokens : 4096
      output.maxOutputTokens = Math.floor(Math.min(currentMax, maxTokens))
      log(`[${taskType}] ${strategy} strategy, maxOutputTokens=${output.maxOutputTokens}`)

      return output
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
