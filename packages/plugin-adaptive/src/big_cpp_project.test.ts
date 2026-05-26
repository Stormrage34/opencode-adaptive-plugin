import path from "path";
import { mkdtempSync, mkdirSync, readdirSync } from "fs";
import { tmpdir } from "../../opencode/test/fixture/fixture";
import { describe, expect, test } from "bun:test";
import { AdaptivePlugin } from "./adaptive";

// Helper to generate a dummy C++ project with many files
async function generateCppProject(root: string, fileCount: number) {
  for (let i = 0; i < fileCount; i++) {
    const filePath = path.join(root, `module_${i}.cpp`);
    await Bun.file(filePath).write(`// Dummy C++ file ${i}\nint func${i}() { return ${i}; }\n`);
  }
}

describe("AdaptivePlugin iteration guard with large C++ project", () => {
  test("guard triggers after many coding steps", async () => {
    await using tmp = await tmpdir();
    const projectRoot = path.join(tmp.path, "cpp_project");
    mkdirSync(projectRoot, { recursive: true });
    // Create 100 dummy C++ source files
    await generateCppProject(projectRoot, 100);

    const MINIMAL_CTX = (dir: string) => ({
      directory: dir,
      client: {} as any,
      project: {} as any,
      worktree: dir,
      experimental_workspace: { register: () => {} },
      serverUrl: new URL("http://localhost:4096"),
      $: undefined as any,
    });

    // Use a low iteration limit to force the guard early
    const hooks = await AdaptivePlugin(MINIMAL_CTX(tmp.path), { maxIterations: 0 });
    const sessionID = "cpp-session";

    // Simulate a professional coder: for each file, a chat.message + a Read tool call
    const cppFiles = readdirSync(projectRoot).filter(f => f.endsWith('.cpp')).map(f => path.join(projectRoot, f)); // get list of files
    // Perform more steps than maxIterations to trigger guard
    for (let i = 0; i < cppFiles.length + 5; i++) {
      await hooks["chat.message"]!({
        sessionID,
        agent: "oracle",
        model: { providerID: "nvidia", modelID: "test" },
      }, {} as any);

      // Read the file (if exists) – simulate coding action
      const file = cppFiles[i % cppFiles.length];
      await hooks["tool.execute.after"]!({
        tool: "Read",
        sessionID,
        callID: `read-${i}`,
        args: { path: file },
      }, { output: "dummy", metadata: {} });
    }

    // Pull metrics after the session
    const metrics = JSON.parse(await hooks.tool!.adaptive_metrics.execute({}, {} as any));
    // Guard should have triggered at least once
    expect((metrics as any).iterationGuardTriggers ?? 0).toBeGreaterThan(0);
    expect((metrics as any).iterationPenalties ?? 0).toBeGreaterThan(0);
    // At least some tool records should be present
    const status = JSON.parse(await hooks.tool!.adaptive_status.execute({}, {} as any));
    expect(status.stats.totalRecords).toBeGreaterThanOrEqual(1);
  });
});
