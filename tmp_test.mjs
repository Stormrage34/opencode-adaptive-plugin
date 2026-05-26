import { AdaptivePlugin } from '/home/stormrage/opencode/packages/plugin-adaptive/src/adaptive.js';
(async () => {
  const ctx = { directory: '/tmp', client: {}, project: {}, worktree: '/tmp', experimental_workspace: { register:()=>{} }, serverUrl: new URL('http://localhost:4096'), $: undefined };
  const hooks = await AdaptivePlugin(ctx, { experimentalActive:true, dedupWindow:0, debug:true });
  await hooks['chat.message']({sessionID:'s1', agent:'oracle', model:{modelID:'test'}}, {});
  const tools = ['Bash','Bash','Bash','Bash','Bash'];
  const errors = [false,true,false,true,true];
  for(let i=0;i<tools.length;i++){
    await hooks['tool.execute.after']({tool:tools[i], sessionID:'s1', callID:'c'+i, args:{}}, {output:'ok', metadata: errors[i]?{error:'fail'}:{}});
  }
  const out={context:[]};
  await hooks['experimental.session.compacting']({sessionID:'s1'}, out);
  console.log('Compaction context:', out.context);
})();