import path from 'path';
import { tmpdir } from '../opencode/test/fixture/fixture';
import { AdaptivePlugin } from './src/adaptive';

(async () => {
  await using tmp = await tmpdir();
  const hooks = await AdaptivePlugin({
    directory: tmp.path,
    client: {} as any,
    project: {} as any,
    worktree: tmp.path,
    experimental_workspace: { register: () => {} },
    serverUrl: new URL('http://localhost:4096'),
    $: undefined as any,
  });
  const sessionID = 'sess1';
  await hooks['chat.message']!({
    sessionID,
    agent: 'oracle',
    model: { providerID: 'nvidia', modelID: 'test' },
  }, {} as any);
  await hooks['tool.execute.after']!({
    tool: 'Read',
    sessionID,
    callID: 'c1',
    args: {},
  }, { output: 'content', metadata: {} });
  const { Database } = await import('bun:sqlite');
  const db = new Database(path.join(tmp.path, '.opencode_telemetry.db'));
  const rows = db.query('SELECT id, agent, tool_name, confidence FROM telemetry_v2').all();
  console.log('Rows:', rows);
})();
