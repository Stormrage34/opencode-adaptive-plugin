// Memory leak stress test — long-running test to verify no unbounded memory growth
// Run: bun test src/memory-leak-stress.test.ts

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import { AdaptivePlugin } from "./adaptive.js"
import { createTelemetryDb } from "./db.js"
import { metrics } from "./metrics.js"
import { tmpdir } from "../../opencode/test/fixture/fixture.js"

describe("Memory leak stress test", () => {
  let db: Database | null = null
  let hooks: any

  beforeEach(async () => {
    // Reset metrics
    metrics.totalInserted = 0
    metrics.duplicateAttempts = 0
    metrics.duplicateWarnings = 0
    metrics.ttlCleanupRuns = 0
    metrics.ttlRecordsDeleted = 0
    metrics.queryStatsCalls = 0
    metrics.queryRecentCalls = 0
    metrics.queryTrendsCalls = 0
    metrics.queryToolStatsCalls = 0
    metrics.cacheEvictions = 0
    metrics.abandonmentPenalties = 0
    metrics.dbErrors = 0
    
    // Create in-memory DB for isolation
    db = createTelemetryDb(":memory:")
    
    // Create plugin instance using the same pattern as other tests
    await using tmp = await tmpdir()
    const MINIMAL_CTX = (dir: string) => ({
      directory: dir,
      client: {} as any,
      project: {} as any,
      worktree: dir,
      experimental_workspace: { register: () => {} },
      serverUrl: new URL("http://localhost:4096"),
      $: undefined as any,
    })
    hooks = await AdaptivePlugin(MINIMAL_CTX(tmp.path))
  })

  afterEach(() => {
    if (db) {
      db.close()
      db = null
    }
    if (hooks?.flush) {
      hooks.flush()
    }
  })

  it("should not leak memory over 200 sessions with tool executions", async () => {
    const startMem = process.memoryUsage()
    console.log("[stress] Initial memory:", {
      rssMB: (startMem.rss / 1024 / 1024).toFixed(2),
      heapUsedMB: (startMem.heapUsed / 1024 / 1024).toFixed(2),
    })

    // Spawn 200 sessions with tool executions (reduced from 1000 for CI)
    const sessionCount = 200

    for (let i = 0; i < sessionCount; i++) {
      const sessionID = `session-${i}`
      const toolName = i % 2 === 0 ? "Bash" : "Read"

      // Simulate chat.message hook
      await hooks["chat.message"](
        {
          sessionID,
          model: { modelID: "test-model" },
          agent: "test-agent",
        },
        {} as any,
      )

      // Simulate tool.execute.after hook with success
      await hooks["tool.execute.after"](
        {
          sessionID,
          tool: toolName,
        },
        {
          output: `output-${i}`,
          metadata: { confidence: 0.8 },
        },
      )

      // Simulate tool.execute.after with failure (50% rate)
      if (i % 2 === 1) {
        await hooks["tool.execute.after"](
          {
            sessionID,
            tool: toolName,
          },
          {
            output: `error-output-${i}`,
            metadata: { error: true, confidence: 0.3 },
          },
        )
      }
    }

    // Force cleanup via flush
    if (hooks?.flush) {
      hooks.flush()
    }

    const endMem = process.memoryUsage()
    console.log("[stress] Final memory:", {
      rssMB: (endMem.rss / 1024 / 1024).toFixed(2),
      heapUsedMB: (endMem.heapUsed / 1024 / 1024).toFixed(2),
      rssGrowthMB: ((endMem.rss - startMem.rss) / 1024 / 1024).toFixed(2),
      heapUsedGrowthMB: ((endMem.heapUsed - startMem.heapUsed) / 1024 / 1024).toFixed(2),
    })

    // Assertions: memory should not grow unboundedly
    // Allow 50MB growth for 1000 sessions (conservative)
    const rssGrowthMB = (endMem.rss - startMem.rss) / 1024 / 1024
    const heapUsedGrowthMB = (endMem.heapUsed - startMem.heapUsed) / 1024 / 1024

    expect(rssGrowthMB).toBeLessThanOrEqual(10)
    expect(heapUsedGrowthMB).toBeLessThanOrEqual(5)

    console.log("[stress] ✅ No memory leak detected over", sessionCount, "sessions")
  }, { timeout: 30_000 })

  it("should handle concurrent tool executions without memory bloat", async () => {
    const startMem = process.memoryUsage()

    // Simulate burst of 20 concurrent sessions (reduced for CI)
    const promises = []
    for (let i = 0; i < 20; i++) {
      const sessionID = `burst-${i}`
      const toolName = i % 3 === 0 ? "Bash" : i % 3 === 1 ? "Read" : "Write"

      promises.push(
        hooks["chat.message"](
          {
            sessionID,
            model: { modelID: "test-model" },
            agent: "test-agent",
          },
          {} as any,
        ),
      )

      promises.push(
        hooks["tool.execute.after"](
          {
            sessionID,
            tool: toolName,
          },
          {
            output: `output-${i}`,
            metadata: { confidence: 0.75 },
          },
        ),
      )
    }

    await Promise.all(promises)

    if (hooks?.flush) {
      hooks.flush()
    }

    const endMem = process.memoryUsage()
    const rssGrowthMB = (endMem.rss - startMem.rss) / 1024 / 1024

    expect(rssGrowthMB).toBeLessThanOrEqual(5)
    console.log("[stress] ✅ Concurrent burst handled without memory bloat:", rssGrowthMB.toFixed(2), "MB growth")
  }, { timeout: 15_000 })

  it("should not leak on repeated flush/cleanup cycles", async () => {
    const snapshots: Array<{ rss: number; heapUsed: number }> = []

    for (let i = 0; i < 5; i++) {
      // Create some sessions
      for (let j = 0; j < 20; j++) {
        const sessionID = `cycle-${i}-${j}`
        await hooks["chat.message"](
          {
            sessionID,
            model: { modelID: "test-model" },
            agent: "test-agent",
          },
          {} as any,
        )
      }

      // Force cleanup via flush
      if (hooks?.flush) {
        hooks.flush()
      }

      const mem = process.memoryUsage()
      snapshots.push({ rss: mem.rss, heapUsed: mem.heapUsed })
    }

    // Check memory growth across cycles
    const first = snapshots[0]
    const last = snapshots[snapshots.length - 1]
    const rssGrowthMB = (last.rss - first.rss) / 1024 / 1024

    expect(rssGrowthMB).toBeLessThanOrEqual(3)
    console.log("[stress] ✅ Flush/cleanup cycles did not leak:", rssGrowthMB.toFixed(2), "MB growth over", snapshots.length, "cycles")
  }, { timeout: 20_000 })
})
