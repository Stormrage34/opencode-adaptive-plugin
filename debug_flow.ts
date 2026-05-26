import { AdaptivePlugin } from "./src/adaptive";
import { tmpdir } from "../opencode/test/fixture/fixture"; // relative path to fixture

async function run() {
  const { path: tmpPath } = await tmpdir();
  const hooks = await AdaptivePlugin({ directory: tmpPath }, {});

  // chat.message for session1
  await hooks["chat.message"]!({
    sessionID: "sess1",
    agent: "oracle",
    model: { providerID: "nvidia", modelID: "test" },
  }, {} as any);

  // tool.execute.after for Read tool
  await hooks["tool.execute.after"]!({
    tool: "Read",
    sessionID: "sess1",
    callID: "c1",
    args: {},
  }, { output: "content", metadata: {} });

  // Query DB directly
  const { Database } = await import("bun:sqlite");
  const db = new Database(`${tmpPath}/.opencode_telemetry.db`);
  const rows = db.query("SELECT id, agent, model, tool_name, confidence FROM telemetry_v2").all();
  console.log("Rows after insertion:", rows);
  db.close();
}

run().catch(e => console.error(e));
