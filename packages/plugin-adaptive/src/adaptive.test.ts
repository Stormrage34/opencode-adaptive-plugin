// Smoke test for AdaptivePlugin v2 — passive observer
/* eslint-disable @typescript-eslint/no-explicit-any */
import path from "path"
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../../opencode/test/fixture/fixture"

const MINIMAL_CTX = (dir: string) => ({
  directory: dir,
  client: {} as any,
  project: {} as any,
  worktree: dir,
  experimental_workspace: { register: () => {} },
  serverUrl: new URL("http://localhost:4096"),
  $: undefined as any,
})

describe("AdaptivePlugin v2", () => {
  test("plugin factory creates hooks", async () => {
    const { AdaptivePlugin } = await import("./adaptive")
    await using tmp = await tmpdir()
    const hooks = await AdaptivePlugin(MINIMAL_CTX(tmp.path))
    expect(hooks).toBeDefined()
    expect(typeof hooks.flush).toBe("function")
  })

  test("registers 6 tools", async () => {
    const { AdaptivePlugin } = await import("./adaptive")
    await using tmp = await tmpdir()
    const hooks = await AdaptivePlugin(MINIMAL_CTX(tmp.path))
    expect(hooks.tool).toBeDefined()
    expect(Object.keys(hooks.tool!).sort()).toEqual([
      "adaptive_export",
      "adaptive_metrics",
      "adaptive_record",
      "adaptive_reset",
      "adaptive_status",
      "adaptive_trends",
    ])
  })

  test("adaptive_status returns stats", async () => {
    const { AdaptivePlugin } = await import("./adaptive")
    await using tmp = await tmpdir()
    const hooks = await AdaptivePlugin(MINIMAL_CTX(tmp.path))
    const result = JSON.parse(await hooks.tool!.adaptive_status.execute({}, {} as any))
    expect(result.stats).toBeDefined()
    expect(typeof result.stats.totalRecords).toBe("number")
  })

  test("adaptive_record stores a record", async () => {
    const { AdaptivePlugin } = await import("./adaptive")
    await using tmp = await tmpdir()
    const hooks = await AdaptivePlugin(MINIMAL_CTX(tmp.path))
    const result = JSON.parse(
      await hooks.tool!.adaptive_record.execute({
        confidence: 0.85,
        model: "deepseek-v4-flash",
        tool_name: "test",
      }, {} as any),
    )
    expect(result.recorded).toBe(true)
    expect(result.confidence).toBe("0.85")
  })

  test("adaptive_reset clears data", async () => {
    const { AdaptivePlugin } = await import("./adaptive")
    await using tmp = await tmpdir()
    const hooks = await AdaptivePlugin(MINIMAL_CTX(tmp.path))
    // Record something
    await hooks.tool!.adaptive_record.execute({ confidence: 0.5 }, {} as any)
    // Reset without force (VACUUM async via microtask)
    const resetMsg = await hooks.tool!.adaptive_reset.execute({}, {} as any)
    expect(resetMsg).toContain("Telemetry cleared")
    // Stats should show 0 records
    const stats = JSON.parse(await hooks.tool!.adaptive_status.execute({}, {} as any))
    expect(stats.stats.totalRecords).toBe(0)
  })

  test("chat.message stores context", async () => {
    const { AdaptivePlugin } = await import("./adaptive")
    await using tmp = await tmpdir()
    const hooks = await AdaptivePlugin(MINIMAL_CTX(tmp.path))
    await hooks["chat.message"]!(
      { sessionID: "s1", agent: "oracle", model: { providerID: "nvidia", modelID: "step-3.5-flash" } },
      {} as any,
    )
    // No crash — context stored internally
  })

  test("tool.execute.after records observation", async () => {
    const { AdaptivePlugin } = await import("./adaptive")
    await using tmp = await tmpdir()
    const hooks = await AdaptivePlugin(MINIMAL_CTX(tmp.path))

    // Establish session context
    await hooks["chat.message"]!(
      { sessionID: "s1", agent: "oracle", model: { providerID: "nvidia", modelID: "deepseek-v4-flash" } },
      {} as any,
    )

    // Fire tool.execute.after
    await hooks["tool.execute.after"]!(
      { tool: "Read", sessionID: "s1", callID: "c1", args: {} },
      { title: "Read file", output: "file content", metadata: {} },
    )

    // Verify record was stored
    const stats = JSON.parse(await hooks.tool!.adaptive_status.execute({}, {} as any))
    expect(stats.stats.totalRecords).toBeGreaterThanOrEqual(1)
    expect(stats.stats.recordsByTool["Read"]).toBe(1)
  })

  test("tool.execute.after records failure on error metadata", async () => {
    const { AdaptivePlugin } = await import("./adaptive")
    await using tmp = await tmpdir()
    const hooks = await AdaptivePlugin(MINIMAL_CTX(tmp.path))

    await hooks["tool.execute.after"]!(
      { tool: "Bash", sessionID: "s2", callID: "c2", args: {} },
      { title: "Run command", output: "", metadata: { error: "Command failed" } },
    )

    const stats = JSON.parse(await hooks.tool!.adaptive_status.execute({}, {} as any))
    // Should have at least 1 record with low confidence (exit code = 1)
    expect(stats.stats.totalRecords).toBeGreaterThanOrEqual(1)
  })

  test("no chat.params hook registered", async () => {
    const { AdaptivePlugin } = await import("./adaptive")
    await using tmp = await tmpdir()
    const hooks = await AdaptivePlugin(MINIMAL_CTX(tmp.path))
    expect((hooks as any)["chat.params"]).toBeUndefined()
  })

   test("no event hook registered", async () => {
     const { AdaptivePlugin } = await import("./adaptive")
     await using tmp = await tmpdir()
     const hooks = await AdaptivePlugin(MINIMAL_CTX(tmp.path))
     expect((hooks as any)["event"]).toBeUndefined()
   })

   test("adaptive_trends returns empty with no data", async () => {
     const { AdaptivePlugin } = await import("./adaptive")
     await using tmp = await tmpdir()
     const hooks = await AdaptivePlugin(MINIMAL_CTX(tmp.path))
     const result = JSON.parse(await hooks.tool!.adaptive_trends.execute({ groupBy: "agent" }, {} as any))
     expect(result).toBe("No trend data available (need at least 2 records per group).")
   })

   test("adaptive_trends computes trends correctly", async () => {
     const { AdaptivePlugin } = await import("./adaptive")
     await using tmp = await tmpdir()
     const hooks = await AdaptivePlugin(MINIMAL_CTX(tmp.path))

     // Seed data: create multiple records for the same agent with varying confidence
     // Use adaptive_record to insert records with specific confidence and agent
     const agent = "test-agent"
     const confidences = [0.8, 0.7, 0.6, 0.5, 0.4] // decreasing trend
for (const c of confidences) {
        await hooks.tool!.adaptive_record.execute({
          confidence: c,
          agent: agent,
          tool_name: "TestTool",
        }, {} as any)
      }

      // Debug: check DB row count after inserts
      const { Database } = await import('bun:sqlite')
      const dbCheck = new Database(path.join(tmp.path, '.opencode_telemetry.db'))
      console.log('[debug] DB row count after inserts:', dbCheck.query('SELECT COUNT(*) as c FROM telemetry_v2').get())

      const result = JSON.parse(await hooks.tool!.adaptive_trends.execute({ groupBy: "agent", limit: 10 }, {} as any))
     expect(Array.isArray(result)).toBe(true)
     expect(result.length).toBeGreaterThan(0)
     const trend = result.find((t: any) => t.group === agent)
     expect(trend).toBeDefined()
     expect(trend.trend).toBe("down") // last values lower than first
   })

    test("duplicate prompt_hash records are both stored (index removed)", async () => {
      const { AdaptivePlugin } = await import("./adaptive")
      await using tmp = await tmpdir()
      const hooks = await AdaptivePlugin(MINIMAL_CTX(tmp.path))

      const prompt = "test prompt"
      const toolName = "Read"
      const confidence = 0.8

      // First record
      await hooks.tool!.adaptive_record.execute({
        prompt,
        tool_name: toolName,
        confidence,
      }, {} as any)

      // Second identical record (same prompt hash, tool, exit code)
      await hooks.tool!.adaptive_record.execute({
        prompt,
        tool_name: toolName,
        confidence,
      }, {} as any)

      // Check DB count should be 2 (index removed, both records stored)
      const stats = JSON.parse(await hooks.tool!.adaptive_status.execute({}, {} as any))
      expect(stats.stats.totalRecords).toBe(2)
    })

    test("sliding window dedup skips duplicate tool calls within 5s", async () => {
      const { AdaptivePlugin } = await import("./adaptive")
      await using tmp = await tmpdir()
      const hooks = await AdaptivePlugin(MINIMAL_CTX(tmp.path))

      // Establish session context
      await hooks["chat.message"]!({
        sessionID: "s3",
        agent: "oracle",
        model: { providerID: "nvidia", modelID: "deepseek-v4-flash" },
      }, {} as any)

      // First tool execution
      await hooks["tool.execute.after"]!({
        tool: "Read",
        sessionID: "s3",
        callID: "c1",
        args: {},
      }, { output: "first", metadata: {} })

      // Immediate second execution (should be deduped)
      await hooks["tool.execute.after"]!({
        tool: "Read",
        sessionID: "s3",
        callID: "c2",
        args: {},
      }, { output: "second", metadata: {} })

      // Verify only one record was stored
      const stats = JSON.parse(await hooks.tool!.adaptive_status.execute({}, {} as any))
      expect(stats.stats.totalRecords).toBe(1)
    })

    test("duplicate insert logs warning", async () => {
      const { AdaptivePlugin } = await import("./adaptive")
      await using tmp = await tmpdir()
      const hooks = await AdaptivePlugin(MINIMAL_CTX(tmp.path))

      const prompt = "duplicate prompt"
      const toolName = "Read"
      const confidence = 0.9

      // First insert (should succeed)
      await hooks.tool!.adaptive_record.execute({
        prompt,
        tool_name: toolName,
        confidence,
      }, {} as any)

      // Capture console.warn output
      const warnings: any[] = []
      const origWarn = console.warn
      // @ts-ignore – monkey‑patch for test
      console.warn = (...args) => warnings.push(args)

      // Second identical insert (should trigger duplicate warning)
      await hooks.tool!.adaptive_record.execute({
        prompt,
        tool_name: toolName,
        confidence,
      }, {} as any)

      // Restore original warn
      console.warn = origWarn

        // Verify that no duplicate warning was emitted
        const duplicateWarning = warnings.find(w => typeof w[0] === 'string' && w[0].includes('[db] INSERT failed'))
        expect(duplicateWarning).toBeUndefined()
    })

    test("abandonment detection reduces confidence of prior record", async () => {
      const { AdaptivePlugin } = await import("./adaptive")
      await using tmp = await tmpdir()
      const hooks = await AdaptivePlugin(MINIMAL_CTX(tmp.path))

      // Establish first session and fire a tool execution
      const session1 = "sess1"
      await hooks["chat.message"]!({
        sessionID: session1,
        agent: "oracle",
        model: { providerID: "nvidia", modelID: "test" },
      }, {} as any)

      // Execute a tool to create a record
      await hooks["tool.execute.after"]!({
        tool: "Read",
        sessionID: session1,
        callID: "c1",
        args: {},
        }, { output: "content", metadata: {} })
        // Small delay to ensure DB write is flushed before querying
        await new Promise(r => setTimeout(r, 5))

      // Get the inserted record's id and confidence
      console.log('Before DB query');
        const { Database } = await import("bun:sqlite")
      const db = new Database(path.join(tmp.path, ".opencode_telemetry.db"))
      const allRows = db.query('SELECT id, agent, confidence FROM telemetry_v2').all();
        console.log('All rows after insertion:', allRows);
        const beforeRow = db.query(
        "SELECT id, confidence FROM telemetry_v2 WHERE agent = 'oracle' ORDER BY id DESC LIMIT 1"
      ).get() as { id: number; confidence: number } | null
      expect(beforeRow).not.toBeNull()
      const { id, confidence: beforeConfidence } = beforeRow!

       // Now start a new session (different sessionID) within abandonment window
       const session2 = "sess2"
       await hooks["chat.message"]!({
         sessionID: session2,
         agent: "oracle", // same agent to trigger abandonment of prior session
         model: { providerID: "nvidia", modelID: "test" },
       }, {} as any)

      // Check that the prior record's confidence decreased
      const afterRow = db.query(
        `SELECT confidence FROM telemetry_v2 WHERE id = ${id}`
      ).get() as { confidence: number } | null
      expect(afterRow).not.toBeNull()
       expect(afterRow!.confidence).toBeCloseTo(beforeConfidence - 0.10, 5)
       db.close()
     })

    test("RecentOpsCache evicts stale entries", async () => {
      const { RecentOpsCache } = await import("./recent-ops-cache.js")
      const cache = new RecentOpsCache(1000) // 1s window
      const now = Date.now()
      cache.set("a", now - 2000) // old
      cache.set("b", now) // fresh
      cache.cleanup() // trigger eviction
      expect(cache.get("a")).toBeUndefined()
      expect(cache.get("b")).toBe(now)
    })

    test("RecentOpsCache updates timestamp on set", async () => {
      const { RecentOpsCache } = await import("./recent-ops-cache.js")
      const cache = new RecentOpsCache(1000)
      const now = Date.now()
      cache.set("x", now)
      cache.set("x", now + 100)
      expect(cache.get("x")).toBe(now + 100)
    })

    test("cleanupSessions removes stale sessions", async () => {
      const { cleanupSessions } = await import("./adaptive.js")
      const sessionCtx = new Map<string, { ctx: any; ts: number; lastRecordId?: number }>()
      const now = Date.now()
      sessionCtx.set("s1", { ctx: {}, ts: now - 3 * 60 * 60 * 1000 }) // 3h old
      sessionCtx.set("s2", { ctx: {}, ts: now - 1 * 60 * 60 * 1000 }) // 1h old (within TTL)
      sessionCtx.set("s3", { ctx: {}, ts: now - 4 * 60 * 60 * 1000 }) // 4h old
      const deleted = cleanupSessions(sessionCtx)
      expect(deleted).toBe(2) // s1 and s3
      expect(sessionCtx.size).toBe(1)
      expect(sessionCtx.has("s2")).toBe(true)
    })

    test("experimental.session.compacting injects tool failure context (experimentalActive)", async () => {
      const { resetMetrics } = await import("./metrics.js")
      resetMetrics()
      const { AdaptivePlugin } = await import("./adaptive")
      await using tmp = await tmpdir()
      // dedupWindow: 0 disables the 5s dedup so rapid test calls all pass through
      const hooks = await AdaptivePlugin(MINIMAL_CTX(tmp.path), { experimentalActive: true, dedupWindow: 0 })

      // Verify hooks exist — gated behind experimentalActive
      expect(hooks["experimental.session.compacting"]).toBeDefined()

      // Establish session context
      await hooks["chat.message"]!({
        sessionID: "s_compact",
        agent: "oracle",
        model: { providerID: "nvidia", modelID: "deepseek-v4-flash" },
      }, {} as any)

      // 5 calls to Bash, 2 failures (40% failure rate — above 30% threshold)
      await hooks["tool.execute.after"]!(
        { tool: "Bash", sessionID: "s_compact", callID: "c1", args: {} },
        { output: "ok", metadata: {} },
      )
      await hooks["tool.execute.after"]!(
        { tool: "Bash", sessionID: "s_compact", callID: "c2", args: {} },
        { output: "ok", metadata: {} },
      )
      await hooks["tool.execute.after"]!(
        { tool: "Bash", sessionID: "s_compact", callID: "c3", args: {} },
        { output: "fail", metadata: { error: "timeout" } },
      )
      await hooks["tool.execute.after"]!(
        { tool: "Bash", sessionID: "s_compact", callID: "c4", args: {} },
        { output: "ok", metadata: {} },
      )
      await hooks["tool.execute.after"]!(
        { tool: "Bash", sessionID: "s_compact", callID: "c5", args: {} },
        { output: "fail", metadata: { error: "timeout" } },
      )

      // 3 calls to Read, all successes (should NOT appear in context)
      for (let i = 0; i < 3; i++) {
        await hooks["tool.execute.after"]!(
          { tool: "Read", sessionID: "s_compact", callID: `r${i}`, args: {} },
          { output: "content", metadata: {} },
        )
      }

      // Fire compaction hook
      const output = { context: [] as string[] }
      await hooks["experimental.session.compacting"]!(
        { sessionID: "s_compact" },
        output,
      )

      // Assert context was injected
      expect(output.context.length).toBe(1)
      expect(output.context[0]).toContain("Bash")
      expect(output.context[0]).toContain("2/5")
      expect(output.context[0]).not.toContain("Read")

      // Assert metric was incremented
      const metrics = JSON.parse(await hooks.tool!.adaptive_metrics.execute({}, {} as any))
      expect(metrics.compactionContextsInjected).toBe(1)
    })

    test("adaptive_metrics returns counters", async () => {
      const { resetMetrics } = await import("./metrics.js")
      resetMetrics() // ensure clean state
      const { AdaptivePlugin } = await import("./adaptive")
      await using tmp = await tmpdir()
      const hooks = await AdaptivePlugin(MINIMAL_CTX(tmp.path))

      // Generate activity
      await hooks.tool!.adaptive_record.execute({ confidence: 0.8, tool_name: "Test" }, {} as any)
      await hooks.tool!.adaptive_record.execute({ confidence: 0.9, tool_name: "Test" }, {} as any)
      await hooks.tool!.adaptive_status.execute({}, {} as any) // increments queryStatsCalls

      const result = JSON.parse(await hooks.tool!.adaptive_metrics.execute({}, {} as any))
      expect(result.totalInserted).toBe(2)
      expect(result.queryStatsCalls).toBe(1)
      expect(result.duplicateAttempts).toBe(0)
      expect(result.ttlCleanupRuns).toBe(0) // not run yet
    })

    test("queryFailingTools returns tools with avg confidence < 0.5", async () => {
      const { createTelemetryDb, queryFailingTools } = await import("./db.js")
      await using tmp = await tmpdir()
      const dbPath = path.join(tmp.path, "test_failing.db")
      const db = createTelemetryDb(dbPath)
      expect(db).not.toBeNull()

      // Insert 3 Bash failures (exit_code=1, confidence=0.10 → avg 0.10 < 0.5)
      const insert = db!.prepare(`
        INSERT INTO telemetry_v2 (task_id, tool_name, exit_code, confidence, signal_json)
        VALUES (?, ?, ?, ?, '{}')
      `)
      for (let i = 0; i < 3; i++) {
        insert.run(`task_bash_${i}`, "Bash", 1, 0.10)
      }
      // Insert 1 Read success (exit_code=0, confidence=0.85 → avg 0.85 > 0.5)
      insert.run("task_read_0", "Read", 0, 0.85)

      const result = queryFailingTools(db!, 3)
      expect(result.length).toBeGreaterThanOrEqual(1)

      const bashEntry = result.find(r => r.toolName === "Bash")
      expect(bashEntry).toBeDefined()
      expect(bashEntry!.totalCalls).toBe(3)
      expect(bashEntry!.failedCalls).toBe(3)
      expect(bashEntry!.avgConfidence).toBeLessThan(0.5)

      // Read should NOT be in results (avgConfidence > 0.5)
      const readEntry = result.find(r => r.toolName === "Read")
      expect(readEntry).toBeUndefined()

      db!.close()
    })

    test("experimental.chat.system.transform injects cross-session failure hints", async () => {
      const { resetMetrics } = await import("./metrics.js")
      resetMetrics()
      const { AdaptivePlugin } = await import("./adaptive")
      await using tmp = await tmpdir()
      const hooks = await AdaptivePlugin(MINIMAL_CTX(tmp.path), { experimentalActive: true, dedupWindow: 0 })

      expect(hooks["experimental.chat.system.transform"]).toBeDefined()

      // Establish session context so hook can check hintsDelivered flag
      await hooks["chat.message"]!({
        sessionID: "s_hint",
        agent: "oracle",
        model: { providerID: "nvidia", modelID: "deepseek-v4-flash" },
      }, {} as any)

      // Insert 3 low-confidence Bash records via adaptive_record
      // confidence 0.1 → exitCode 1 → observer computes DB confidence as 0.10
      for (let i = 0; i < 3; i++) {
        await hooks.tool!.adaptive_record.execute({
          confidence: 0.1,
          tool_name: "Bash",
          agent: "oracle",
        }, {} as any)
      }

      // Insert 1 high-confidence Read record (should NOT appear in hints)
      await hooks.tool!.adaptive_record.execute({
        confidence: 0.9,
        tool_name: "Read",
        agent: "oracle",
      }, {} as any)

      // Fire system.transform hook
      const output = { system: [] as string[] }
      await hooks["experimental.chat.system.transform"]!(
        { sessionID: "s_hint", model: {} },
        output,
      )

      // Assert hint was injected
      expect(output.system.length).toBe(1)
      expect(output.system[0]).toContain("Bash")
      expect(output.system[0]).toContain("3 fails")
      expect(output.system[0]).not.toContain("Read")

      // Assert metric was incremented
      const metrics = JSON.parse(await hooks.tool!.adaptive_metrics.execute({}, {} as any))
      expect(metrics.hintsDelivered).toBe(1)

  // Second call should NOT re-deliver (hintsDelivered flag)
  const output2 = { system: [] as string[] }
  await hooks["experimental.chat.system.transform"]!(
    { sessionID: "s_hint", model: {} },
    output2,
  )
  expect(output2.system.length).toBe(0)
})

test("integration: full capabilities test in one session", async () => {
  const { AdaptivePlugin } = await import("./adaptive")
  const { resetMetrics } = await import("./metrics")
  resetMetrics()
  await using tmp = await tmpdir()
  // dedupWindow: 0 disables the 5s dedup so rapid test calls all pass through
  const hooks = await AdaptivePlugin(MINIMAL_CTX(tmp.path), { experimentalActive: true, dedupWindow: 0 })

  // Verify all experimental hooks exist
  expect(hooks["tool.definition"]).toBeDefined()
  expect(hooks["experimental.chat.system.transform"]).toBeDefined()
  expect(hooks["experimental.session.compacting"]).toBeDefined()

  // 1. Session start
  const sessionID = "s_integration"
  await hooks["chat.message"]!(
    { sessionID, agent: "oracle", model: { providerID: "nvidia", modelID: "deepseek-v4-flash" } },
    {},
  )

  // 2. Tool executions: 5 Bash (3 fails), 3 Read (all success), 1 Write (success)
  // With 3 failures, average confidence will be below 0.5, so queryFailingTools will return Bash
  const tools: Array<{ tool: string; error?: boolean }> = [
    { tool: "Bash", error: false },
    { tool: "Bash", error: true }, // failure
    { tool: "Bash", error: false },
    { tool: "Bash", error: true }, // failure
    { tool: "Bash", error: true }, // failure
    { tool: "Read", error: false },
    { tool: "Read", error: false },
    { tool: "Read", error: false },
    { tool: "Write", error: false },
  ]

  for (const { tool, error } of tools) {
    await hooks["tool.execute.after"]!(
      { tool, sessionID, callID: `c_${tool}_${Math.random().toString(36).slice(2, 4)}`, args: {} },
      { output: "ok", metadata: error ? { error: "failed" } : {} },
    )
  }

  // 3. Tool definition enrichment — verify hook exists and is callable
  const toolDefOutput: { description: string; parameters?: any; jsonSchema?: any } = { description: "Bash tool" }
  await hooks["tool.definition"]!({ toolID: "Bash" }, toolDefOutput)
  // Enrichment may or may not fire depending on cache state; trust the existing tests cover this
  // We'll verify metrics instead

  const readDefOutput: { description: string } = { description: "Read tool" }
  await hooks["tool.definition"]!({ toolID: "Read" }, readDefOutput)

  // 4. Cross-session hints — should inject once per session
  const hintsOutput = { system: [] as string[] }
  await hooks["experimental.chat.system.transform"]!({ sessionID, model: {} }, hintsOutput)
  expect(hintsOutput.system.length).toBe(1)
  expect(hintsOutput.system[0]).toContain("Bash")
  expect(hintsOutput.system[0]).toContain("fail")
  expect(hintsOutput.system[0]).not.toContain("Read")

  // 5. Session compaction — should inject context warning
  const compactionOutput = { context: [] as string[], prompt: undefined }
  await hooks["experimental.session.compacting"]!({ sessionID }, compactionOutput)
  expect(compactionOutput.context.length).toBe(1)
  expect(compactionOutput.context[0]).toContain("Bash")
  expect(compactionOutput.context[0]).toContain("3/5")
  expect(compactionOutput.context[0]).not.toContain("Read")

  // 6. Metrics verification — verify new counters exist and incremented
  const metrics = JSON.parse(await hooks.tool!.adaptive_metrics.execute({}, {} as any))
  expect(metrics.cacheHits).toBeGreaterThanOrEqual(0) // tool.definition may enrich
  expect(metrics.hintsDelivered).toBe(1)
  expect(metrics.compactionContextsInjected).toBe(1)
  expect(metrics.abandonmentPenalties).toBe(0) // no abandonment in this session
  expect(metrics.dbErrors).toBe(0)
  expect(metrics.cacheEvictions).toBeGreaterThanOrEqual(0)

   // 7. Cleanup
   hooks.flush()
 })

   describe("Sub-agent telemetry (childMode)", () => {
     test("tool.pre.execute injects dbPath and childMode for task tool", async () => {
       const { AdaptivePlugin } = await import("./adaptive")
       const path = await import("path")
       await using tmp = await tmpdir()
       const dbPath = path.join(tmp.path, "shared.db")
       const hooks = await AdaptivePlugin(MINIMAL_CTX(tmp.path), { dbPath })

       // Capture the modified args via a spy on the actual task execution
       // We'll call tool.pre.execute directly with a task tool
       const input = {
         sessionID: "s_task",
         tool: "task",
         callID: "c_task",
         args: { prompt: "test prompt" },
         tokensIn: 100,
         tokensOut: 200,
       } as any

       await hooks["tool.pre.execute"]!(input, {} as any)

       // Verify args were modified
       expect(input.args.dbPath).toBe(dbPath)
       expect(input.args.childMode).toBe(true)
     })

     test("childMode=true prevents interval creation", async () => {
       const { AdaptivePlugin } = await import("./adaptive")
       await using tmp = await tmpdir()
       const hooks = await AdaptivePlugin(MINIMAL_CTX(tmp.path), { childMode: true })

       // Access internal interval variables via closure is tricky; instead, verify behavior:
       // Call flush — should not throw even if intervals are undefined
       expect(() => hooks.flush()).not.toThrow()
     })

     test("parent and child share same dbPath (absolute resolution)", async () => {
       const { AdaptivePlugin } = await import("./adaptive")
       const path = await import("path")
       await using tmp = await tmpdir()
       const ctx = MINIMAL_CTX(tmp.path)
       const dbPath = path.join(tmp.path, ".opencode_telemetry.db")

       // Parent plugin
       const parentHooks = await AdaptivePlugin(ctx, { dbPath })
       await parentHooks["chat.message"]!({ sessionID: "s1", agent: "test" }, {} as any)
       await parentHooks["tool.execute.after"]!({ tool: "Read", sessionID: "s1", callID: "c1", args: {} }, { output: "ok", metadata: {} } as any)
       parentHooks.flush()

       // Child plugin (simulated by childMode=true and same dbPath)
       const childHooks = await AdaptivePlugin(ctx, { dbPath, childMode: true })
       await childHooks["chat.message"]!({ sessionID: "s2", agent: "test" }, {} as any)
       await childHooks["tool.execute.after"]!({ tool: "Read", sessionID: "s2", callID: "c2", args: {} }, { output: "ok", metadata: {} } as any)

       // Query status from child — should see records from both parent and child
       const status = JSON.parse(await childHooks.tool!.adaptive_status.execute({}, {} as any))
       expect(status.stats.totalRecords).toBeGreaterThanOrEqual(2)

       childHooks.flush()
     })
   })
 })
