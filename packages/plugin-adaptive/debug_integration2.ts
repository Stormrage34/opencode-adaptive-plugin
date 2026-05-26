import { AdaptivePlugin } from './src/adaptive.js';
import { tmpdir } from '../../opencode/test/fixture/fixture.js';

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

  // Wait a bit for microtasks
  await new Promise(r => setTimeout(r, 10));

  const compactOutput = { context: [] as string[] };
  await hooks['experimental.session.compacting']!({ sessionID }, compactOutput);
  console.log('Compaction context:', compactOutput.context);
})();
