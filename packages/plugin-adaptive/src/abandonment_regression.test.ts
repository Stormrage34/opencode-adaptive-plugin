import { AdaptivePlugin } from "./adaptive.js"
import { tmpdir } from "../../opencode/test/fixture/fixture.js"
import { describe, expect, test } from "bun:test"

/**
 * Regression test for abandonment handling.
 * Ensures that after a second session triggers abandonment detection,
 * the first session is retained for compaction enrichment.
 */

describe('Abandonment regression', () => {
  test('first session compaction works after second session created', async () => {
    const { resetMetrics } = await import('./metrics.js')
    resetMetrics()

    const { AdaptivePlugin } = await import('./adaptive.js')
    const tmp = await tmpdir()
    const MINIMAL_CTX = (dir: string) => ({
      directory: dir,
      client: {} as any,
      project: {} as any,
      worktree: dir,
      experimental_workspace: { register: () => {} },
      serverUrl: new URL('http://localhost:4096'),
      $: undefined as any,
    })

    const hooks = await AdaptivePlugin(MINIMAL_CTX(tmp.path), {
      experimentalActive: true,
      dedupWindow: 0,
      abandonmentTTL: 1000, // short TTL for test speed (not required for this assertion)
    })

    const sessionA = 'sessA'
    const sessionB = 'sessB'

    // Start first session and generate some tool failures
    await hooks["chat.message"]!({ sessionID: sessionA, agent: 'oracle', model: { providerID: 'nvidia', modelID: 'step-3.5-flash' } }, {} as any)
    const bashResults = [
      { output: 'ok', metadata: {} },
      { output: 'fail', metadata: { error: 'timeout' } },
      { output: 'fail2', metadata: { error: 'cmd not found' } },
    ]
    for (let i = 0; i < bashResults.length; i++) {
      await hooks["tool.execute.after"]!({ tool: 'Bash', sessionID: sessionA, callID: `bash_${i}`, args: { command: `echo ${i}` } }, bashResults[i])
    }

    // Create second session to trigger abandonment of the first
    await hooks["chat.message"]!({ sessionID: sessionB, agent: 'oracle', model: { providerID: 'nvidia', modelID: 'step-3.5-flash' } }, {} as any)

    // Compaction for first session should still inject failure context
    const compactOutput = { context: [] as string[] }
    await hooks["experimental.session.compacting"]!({ sessionID: sessionA }, compactOutput)
    expect(compactOutput.context.length).toBeGreaterThanOrEqual(1)
    const ctx = compactOutput.context[0]
    expect(ctx).toContain('Bash')
    expect(ctx).toContain('fails')
  })
})
