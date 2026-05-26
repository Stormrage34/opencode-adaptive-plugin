import { AdaptivePlugin } from "./src/adaptive";
import { tmpdir } from "../opencode/test/fixture/fixture";

async function run() {
  const { path: tmpPath } = await tmpdir();
  const hooks = await AdaptivePlugin({ directory: tmpPath }, {});

  // First session with proper chat.message
  await hooks["chat.message"]!({
    sessionID: "sess1",
    agent: "oracle",
    model: { providerID: "nvidia", modelID: "test" },
  }, {} as any);

  // First tool execution (should have ctx with agent)
  await hooks["tool.execute.after"]!({
    tool: "Read",
    sessionID: "sess1",
    callID: "c1",
    args: {},
  }, { output: "content", metadata: {} });

  // Second tool execution without prior chat.message (ctx empty)
  console.log('Before second tool.execute.after');
  await new Promise(r => setTimeout(r, 10));
  await hooks["tool.execute.after"]!({
    tool: "Read",
    sessionID: "sess1",
    callID: "c2",
    args: {},
  }, { output: "content2", metadata: {} });

  // Query DB
  const { Database } = await import("bun:sqlite");
  const db = new Database(`${tmpPath}/.opencode_telemetry.db`);
  const rows = db.query("SELECT id, agent, confidence FROM telemetry_v2 ORDER BY id").all();
  console.log("All rows:", rows);
  const oracleRow = db.query("SELECT id, confidence FROM telemetry_v2 WHERE agent = 'oracle' ORDER BY id DESC LIMIT 1").get();
  console.log("Oracle row:", oracleRow);
  db.close();
}

run().catch(e => console.error(e));
