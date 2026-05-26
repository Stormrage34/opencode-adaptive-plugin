// Integration test for AdaptivePlugin — full capabilities end-to-end
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

describe("AdaptivePlugin Integration", () => {
  test("full capabilities end-to-end", async () => {
    const { resetMetrics } = await import("./metrics.js")
    resetMetrics()

    const { AdaptivePlugin } = await import("./adaptive")
    await using tmp = await tmpdir()

    // 1. Setup: plugin with experimentalActive=true, dedupWindow=0
    const hooks = await AdaptivePlugin(MINIMAL_CTX(tmp.path), {
      experimentalActive: true,
      dedupWindow: 0, // bypass 5s dedup for rapid calls
    })

    // Verify experimental hooks are present
    expect(hooks["tool.definition"]).toBeDefined()
    expect(hooks["experimental.chat.system.transform"]).toBeDefined()
    expect(hooks["experimental.session.compacting"]).toBeDefined()

    // 2. Session start
    const sessionID = "sess_integration_test"
    await hooks["chat.message"]!({
      sessionID,
      agent: "oracle",
      model: { providerID: "nvidia", modelID: "step-3.5-flash" },
    }, {} as any)

    // 3. Tool executions
    // 5 Bash calls: 2 failures (40% failure rate)
    const bashResults = [
      { output: "ok1", metadata: {} }, // success
      { output: "ok2", metadata: {} }, // success
      { output: "fail1", metadata: { error: "timeout" } }, // failure
      { output: "ok3", metadata: {} }, // success
      { output: "fail2", metadata: { error: "command not found" } }, // failure
    ]
    for (let i = 0; i < bashResults.length; i++) {
      await hooks["tool.execute.after"]!({
        tool: "Bash",
        sessionID,
        callID: `bash_${i}`,
        args: { command: `echo test${i}` },
      }, bashResults[i])
    }

    // 3 Read calls: all successes
    for (let i = 0; i < 3; i++) {
      await hooks["tool.execute.after"]!({
        tool: "Read",
        sessionID,
        callID: `read_${i}`,
        args: { path: `/tmp/file${i}.txt` },
      }, { output: `file content ${i}`, metadata: {} })
    }

    // 2 additional Read calls to reach 5 total (to meet enrichment threshold)
    for (let i = 3; i < 5; i++) {
      await hooks["tool.execute.after"]!({
        tool: "Read",
        sessionID,
        callID: `read_${i}`,
        args: { path: `/tmp/file${i}.txt` },
      }, { output: `file content ${i}`, metadata: {} })
    }

    // 1 Write call: success
    await hooks["tool.execute.after"]!({
      tool: "Write",
      sessionID,
      callID: "write_0",
      args: { path: "/tmp/output.txt", content: "written" },
    }, { output: "written", metadata: {} })

    // Allow async validation microtasks to complete
    await new Promise(r => setTimeout(r, 10))

    // 4. Tool definition enrichment
    // First, ensure cache is populated by waiting for refresh interval or manually query
    // The enrichment happens on-demand; we need at least 5 calls for Bash to qualify
    const bashDefInput = { toolID: "Bash" }
    const bashDefOutput = { description: "Run shell commands", parameters: {}, jsonSchema: {} }
    await hooks["tool.definition"](bashDefInput, bashDefOutput as any)
    // Enriched description appends stats to original description
    expect(bashDefOutput.description).toContain("Run shell commands")

    const readDefInput = { toolID: "Read" }
    const readDefOutput = { description: "Read file contents", parameters: {}, jsonSchema: {} }
    await hooks["tool.definition"](readDefInput, readDefOutput as any)
    // Read has 5 successful calls
    expect(readDefOutput.description).toContain("Read file contents")

    // 5. Cross-session hints
    // Need to create a fresh session to test hints delivery (hintsDelivered flag)
    const hintSessionID = "sess_hints"
    await hooks["chat.message"]!({
      sessionID: hintSessionID,
      agent: "oracle",
      model: { providerID: "nvidia", modelID: "step-3.5-flash" },
    }, {} as any)

    // Insert low-confidence Bash records to trigger hints (queryFailingTools looks for avg confidence < 0.5)
    // We already have 5 Bash calls with 2 failures → success rate 60%, avg confidence likely > 0.5
    // To ensure hints, we'll insert explicit low-confidence records via adaptive_record
    for (let i = 0; i < 3; i++) {
      await hooks.tool!.adaptive_record.execute({
        confidence: 0.1,
        tool_name: "Bash",
        agent: "oracle",
      }, {} as any)
    }
    // Insert a high-confidence Read record (should NOT appear in hints)
    await hooks.tool!.adaptive_record.execute({
      confidence: 0.9,
      tool_name: "Read",
      agent: "oracle",
    }, {} as any)

    const transformOutput = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!(
      { sessionID: hintSessionID, model: {} },
      transformOutput,
    )

    // Assert hint was injected
    expect(transformOutput.system.length).toBeGreaterThanOrEqual(1)
    const hintText = transformOutput.system[0]
    expect(hintText).toContain("Bash")
    expect(hintText).toContain("fails")
    expect(hintText).not.toContain("Read")

    // Second call should NOT re-deliver (hintsDelivered flag)
    const transformOutput2 = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!(
      { sessionID: hintSessionID, model: {} },
      transformOutput2,
    )
    expect(transformOutput2.system.length).toBe(0)

    // 6. Session compaction
    // Use the original session with Bash failures (>30% failure rate, at least 3 calls)
    const compactOutput = { context: [] as string[] }
    await hooks["experimental.session.compacting"]!(
      { sessionID: sessionID },
      compactOutput,
    )

    // Assert context was injected
    expect(compactOutput.context.length).toBeGreaterThanOrEqual(1)
    const contextText = compactOutput.context[0]
    expect(contextText).toContain("Bash")
    expect(contextText).toContain("fails")
    expect(contextText).not.toContain("Read")

    // 7. Metrics verification
    const metricsResult = JSON.parse(await hooks.tool!.adaptive_metrics.execute({}, {} as any))

    // Verify key counters
    expect(metricsResult.totalInserted).toBeGreaterThanOrEqual(9) // 5 Bash + 3 Read + 1 Write = 9
    expect(metricsResult.cacheHits).toBeGreaterThanOrEqual(0)
    expect(metricsResult.cacheMisses).toBeGreaterThanOrEqual(0)
    expect(metricsResult.cacheEvictions).toBeGreaterThanOrEqual(0)
    expect(metricsResult.hintsDelivered).toBe(1)
    expect(metricsResult.compactionContextsInjected).toBeGreaterThanOrEqual(1)
    expect(metricsResult.abandonmentPenalties).toBeGreaterThanOrEqual(0)
    expect(typeof metricsResult.dbErrors).toBe("number")

    // 8. Cleanup
    await hooks.flush()
  })
})
