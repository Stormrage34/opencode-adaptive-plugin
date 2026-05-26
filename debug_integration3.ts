import { AdaptivePlugin } from './src/adaptive.js';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

(async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'plugin-adaptive-'));
  const hooks = await AdaptivePlugin({
    directory: tempDir,
    client: {} as any,
    project: {} as any,
    worktree: tempDir,
    experimental_workspace: { register: () => {} },
    serverUrl: new URL('http://localhost:4096'),
    $: undefined as any,
  }, { experimentalActive: true, dedupWindow: 0, debug: true });

  const sessionID = 'sess_debug';
  await hooks['chat.message']!({ sessionID, agent: 'oracle', model: { providerID: 'nvidia', modelID: 'step-3.5-flash' } }, {} as any);

  const bashResults = [
    { output: 'ok1', metadata: {} },
    { output: 'ok2', metadata: {} },
    { output: 'fail1', metadata: { error: 'timeout' } },
    { output: 'ok3', metadata: {} },
    { output: 'fail2', metadata: { error: 'command not found' } },
  ];
  for (let i = 0; i < bashResults.length; i++) {
    await hooks['tool.execute.after']!({ tool: 'Bash', sessionID, callID: `bash_${i}`, args: {} }, bashResults[i]);
  }

  await new Promise(r => setTimeout(r, 10));

  const compactOutput = { context: [] as string[] };
  await hooks['experimental.session.compacting']!({ sessionID }, compactOutput);
  console.log('Compaction context:', compactOutput.context);
})();
