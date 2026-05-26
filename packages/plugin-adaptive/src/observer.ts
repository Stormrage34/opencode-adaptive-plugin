// Auto-Observer — harvests implicit signals from tool execution

let pendingValidationCount = 0;
const MAX_PENDING_VALIDATIONS = 200;
// Sync path: base confidence from exit code + duration (<0.2ms)
// Async path: output validation + optional confidence UPDATE (deferred)

import { createHash } from "crypto"
import { writeRecord, type TelemetryRecord, type Database } from "./db.js"
import { metrics } from "./metrics.js"

// Signal weights (cumulative, base = 0.5)
const DEFAULT_SIGNALS: Record<string, number> = {
  tool_success: +0.35,         // Tool completed without error
  tool_failed: -0.40,          // Tool returned error/failure
  user_accept: +0.45,          // Explicit user acceptance signal
  user_reject: -0.50,          // Explicit rejection
  user_new: -0.60,             // User started new task (abandoned previous)
  edit_small: +0.20,           // Output likely accepted (small or no edit distance)
  validation_pass: +0.15,      // Output passes structural checks
  parse_fail: -0.15,           // Output parsing/validation failed
  timeout: -0.25,              // Execution took too long
}

// Configurable confidence weights (default to static SIGNALS)
let confidenceWeights: Record<string, number> = { ...DEFAULT_SIGNALS }
export function setConfidenceWeights(weights: Record<string, number>) {
  confidenceWeights = { ...weights }
}



export interface ObserverContext {
  model?: string
  agent?: string
  promptHash?: string  // for deduplication
  tokensIn?: number
  tokensOut?: number
}

export interface ToolResult {
  toolName: string
  exitCode: number           // 0 = success, non-zero = failure
  output: string
  metadata?: Record<string, unknown>
  durationMs?: number
}

// Fast sync confidence — no validation, no allocation.
// Runs on every tool call in the hot path.
export function computeBaseConfidence(exitCode: number, durationMs?: number): number {
  let confidence = 0.5  // base
  confidence += exitCode === 0 ? 0.35 : -0.40
  if (durationMs && durationMs > 30000) confidence -= 0.25
  return Math.min(1, Math.max(0, confidence))
}

// Lightweight output validation (structural checks only)
function validateOutput(output: string): number {
  let score = 1.0
  // Unbalanced code fences
  if (output.includes("```") && ((output.match(/```/g)?.length ?? 0) % 2 !== 0)) score -= 0.3
  // Truncation markers
  if (/\[Omitted\]|\.\.\.\s*$/.test(output)) score -= 0.2
  // Looks like JSON but doesn't parse
  if (output.includes("{") && !tryParseJSON(output)) score -= 0.3
  return Math.max(0, score)
}

function tryParseJSON(s: string): boolean {
  try { JSON.parse(s); return true } catch { return false }
}

// Observe a tool execution: sync INSERT + async validation
// Sync path: base confidence → INSERT (<0.5ms total)
// Async path: microtask → validateOutput → optional UPDATE
// Returns the inserted rowId (or null if failed)
export function observe(
  db: Database | null,
  ctx: ObserverContext,
  result: ToolResult,
): number | bigint | null {
  if (!db) return null

  // Base confidence from exit code & duration
  const baseConfidence = computeBaseConfidence(result.exitCode, result.durationMs)

  const signals: Record<string, boolean | number> = {
    tool_success: result.exitCode === 0,
    tool_failed: result.exitCode !== 0,
    timeout: !!(result.durationMs && result.durationMs > 30000),
  }

  // Apply configurable confidence weights (linear additive)
  let weightedAdjustment = 0
  for (const [key, value] of Object.entries(signals)) {
    const weight = confidenceWeights[key] ?? 0
    weightedAdjustment += weight * (typeof value === 'boolean' ? (value ? 1 : 0) : Number(value))
  }
  const confidence = Math.min(1, Math.max(0, baseConfidence + weightedAdjustment))

  const rec: TelemetryRecord = {
    taskId: `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    model: ctx.model,
    agent: ctx.agent,
    toolName: result.toolName,
    tokensIn: ctx.tokensIn ?? 0,
    tokensOut: ctx.tokensOut ?? 0,
    exitCode: result.exitCode,
    confidence,
    signalJson: JSON.stringify(signals),
    promptHash: ctx.promptHash,
  }

  // Synchronous INSERT — fast, <0.5ms
  const rowId = writeRecord(db, rec)
  if (rowId == null) return null

  // Async validation — deferred to microtask, fire-and-forget with back‑pressure guard
  if (pendingValidationCount >= MAX_PENDING_VALIDATIONS) {
    // Drop this validation to avoid unbounded queue
    metrics.validationQueueDrops++;
    // Queue full – dropping validation (debug disabled)
  } else {
    pendingValidationCount++;
    queueMicrotask(() => {
      try {
        const valScore = validateOutput(result.output)
        if (valScore < 0.5) {
          const adjustedConfidence = Math.min(1, Math.max(0, confidence - 0.15))
          const adjustedSignals = { ...signals, parse_fail: true, validation_score: valScore }
          db!.run(
            "UPDATE telemetry_v2 SET confidence = ?, signal_json = ? WHERE id = ?",
            adjustedConfidence,
            JSON.stringify(adjustedSignals),
            Number(rowId),
          )
        }
      } catch {
        /* silent drop — validation is advisory, best-effort */
      } finally {
        pendingValidationCount--;
      }
    })
  }

  return rowId
}

// Create a stable hash from prompt text (for deduplication)
export function hashPrompt(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 16)
}
