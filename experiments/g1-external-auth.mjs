import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Synthetic credentials only. This experiment never opens the user's CODEX_HOME.
const executable = process.env.G1_CODEX_EXE || path.join(process.env.APPDATA,
  'npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
const home = await mkdtemp(path.join(tmpdir(), 'codex-workspace-g1-'));
const children = [], clients = [], requests = [], checks = [], terminals = [], adapters = [];
let rejectNext = false, refreshRequests = 0, refreshAccount = 'C', quotaNext = false, quotaThread = null;
const jwt = id => [Buffer.from('{"alg":"none"}').toString('base64url'), Buffer.from(JSON.stringify({
  sub: `synthetic-${id}`, exp: Math.floor(Date.now() / 1000) + 3600,
  email: `${id}@example.invalid`, 'https://api.openai.com/auth': {chatgpt_account_id: id, chatgpt_plan_type: 'pro'},
})).toString('base64url'), 'synthetic'].join('.');
const tokenAccount = token => JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).sub;
const server = createServer(async (req, res) => {
  for await (const _ of req) { /* consume request without persisting prompts */ }
  if (!req.url.includes('/responses')) { res.writeHead(200, {'content-type':'application/json'}); res.end('{"commit_attribution_enabled":false}'); return; }
  requests.push({accountId:req.headers['chatgpt-account-id'], subject: tokenAccount(req.headers.authorization.replace('Bearer ', ''))});
  if (quotaNext && (!quotaThread || req.headers['thread-id'] === quotaThread)) { quotaNext=false; res.writeHead(429,{'content-type':'application/json'});res.end(JSON.stringify({error:{type:'usage_limit_reached',message:'Synthetic quota limit',plan_type:'pro',resets_at:Math.floor(Date.now()/1000)+60}}));return; }
  if (rejectNext) { rejectNext = false; res.writeHead(401, {'content-type':'application/json'}); res.end('{"error":{"message":"synthetic expired token","type":"invalid_request_error","code":"invalid_api_key"}}'); return; }
  res.writeHead(200, {'content-type':'text/event-stream'});
  const events = [
    {type:'response.created',response:{id:'resp-g1'}},
    {type:'response.output_item.done',item:{type:'message',role:'assistant',id:'msg-g1',content:[{type:'output_text',text:'synthetic turn ok'}]}},
    {type:'response.completed',response:{id:'resp-g1',usage:{input_tokens:1,output_tokens:1,total_tokens:2}}},
  ];
  res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const config = `model = "mock-model"\nmodel_provider = "mock_provider"\nchatgpt_base_url = "${base}/backend-api"\n[model_providers.mock_provider]\nname = "Synthetic G1"\nbase_url = "${base}/v1"\nwire_api = "responses"\nrequires_openai_auth = true\nrequest_max_retries = 0\nstream_max_retries = 0\n`;
await writeFile(path.join(home, 'config.toml'), config);
await mkdir(path.join(home, 'skills/g1-sentinel'), {recursive:true});
const skill = '---\nname: g1-sentinel\ndescription: Synthetic unchanged fixture\n---\nDo not change this fixture.\n';
await writeFile(path.join(home, 'skills/g1-sentinel/SKILL.md'), skill);

async function connect(url) {
  let socket;
  for (let i=0; i<100; i++) {
    socket = new WebSocket(url);
    try { await new Promise((resolve,reject) => { socket.addEventListener('open',resolve,{once:true}); socket.addEventListener('error',reject,{once:true}); }); break; }
    catch { if (i===99) throw new Error('app-server startup timed out'); await new Promise(resolve=>setTimeout(resolve,100)); }
  }
  let seq=0;
  const pending = new Map(), events = [];
  socket.addEventListener('message', ({data}) => {
    const message=JSON.parse(data);
    if (message.method) {
      events.push(message);
      if (message.method==='account/chatgptAuthTokens/refresh') {
        refreshRequests++;
        socket.send(JSON.stringify({id:message.id,result:{accessToken:jwt(`${refreshAccount}-refreshed`),chatgptAccountId:refreshAccount,chatgptPlanType:'pro'}}));
      }
    } else if (pending.has(message.id)) {
      const entry=pending.get(message.id); pending.delete(message.id); clearTimeout(entry.timer);
      if(message.error) entry.reject(new Error(JSON.stringify(message.error))); else entry.resolve(message.result);
    }
  });
  const client = {socket,events,url, call(method,params={}) {return new Promise((resolve,reject)=>{
    const id=++seq, timer=setTimeout(()=>{pending.delete(id);reject(new Error(`RPC timeout: ${method}`));},20000);
    pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));
  });}};
  clients.push(client);
  await client.call('initialize',{clientInfo:{name:'codex_workspace_g1',title:'Synthetic G1',version:'0.1.0'},capabilities:{experimentalApi:true}});
  socket.send(JSON.stringify({method:'initialized'}));
  return client;
}
async function start() {
  const reserve=createServer(); await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));
  const port=reserve.address().port; await new Promise(resolve=>reserve.close(resolve));
  const child=spawn(executable,['app-server','-c','cli_auth_credentials_store="ephemeral"','--listen',`ws://127.0.0.1:${port}`],{env:{...process.env,CODEX_HOME:home},windowsHide:true,stdio:['ignore','ignore','pipe']});
  children.push(child); let stderr=''; child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-4000);});
  child.on('error',error=>{stderr+=error.message;});
  try{return await connect(`ws://127.0.0.1:${port}`);}catch(error){throw new Error(`${error.message}: ${stderr}`);}
}
async function login(client, id) {
  const result=await client.call('account/login/start',{type:'chatgptAuthTokens',accessToken:jwt(id),chatgptAccountId:id,chatgptPlanType:'pro'});
  assert.equal(result.type,'chatgptAuthTokens');
}
async function turn(client, threadId) {
  const start=client.events.length;
  await client.call('turn/start',{threadId,input:[{type:'text',text:'Reply briefly.',text_elements:[]}]});
  for(let i=0;i<200;i++) {
    const complete=client.events.slice(start).find(event=>event.method==='turn/completed');
    if(complete){assert.equal(complete.params.turn.status,'completed',JSON.stringify(complete.params.turn));return;}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error('turn completion timed out');
}
let result;
try {
  const a=await start(), b=await start();
  await login(a,'A'); await login(b,'B');
  const ta=(await a.call('thread/start',{model:'mock-model',cwd:home})).thread.id;
  const tb=(await b.call('thread/start',{model:'mock-model',cwd:home})).thread.id;
  await Promise.all([turn(a,ta),turn(b,tb)]);
  assert.deepEqual(requests.map(r=>r.accountId).sort(),['A','B']);
  assert.deepEqual(requests.map(r=>r.subject).sort(),['synthetic-A','synthetic-B']);
  checks.push('Two simultaneous app-servers use distinct account headers and tokens with one shared CODEX_HOME');
  await login(a,'C'); requests.length=0;
  await Promise.all([turn(a,ta),turn(b,tb)]);
  assert.deepEqual(requests.map(r=>r.accountId).sort(),['B','C']);
  checks.push('Switching A to C preserves B and continues both original threads');
  if(process.env.G1_TUI==='1') {
    const {default:pty}=await import('node-pty');
    for(const [client,threadId] of [[a,ta],[b,tb]]) {
      const terminal=pty.spawn(executable,['--remote',client.url,'resume',threadId],{name:'xterm-256color',cols:100,rows:30,cwd:home,env:{...process.env,CODEX_HOME:home,TERM:'xterm-256color'}});
      terminals.push(terminal);
      let output=''; terminal.onData(data=>{
        output=(output+data).slice(-20000);
        if(data.includes('\x1b[6n'))terminal.write('\x1b[1;1R');
      });
      for(let i=0;i<150 && !output.includes('mock-model');i++){if(output.includes('Do you trust the contents')){output='';terminal.write('\r');}await new Promise(resolve=>setTimeout(resolve,100));}
      assert.ok(output.includes('mock-model'),`TUI failed to show model: ${output.slice(-2000)}`);
    }
    checks.push('Two native PTY remote TUIs attach to the existing threads while runtime WebSockets remain connected');
  }
  requests.length=0; rejectNext=true; await turn(a,ta);
  const cRequests=requests.filter(request=>request.accountId==='C');
  assert.equal(refreshRequests,1); assert.equal(cRequests.length,2);
  assert.deepEqual(cRequests.map(r=>r.subject),['synthetic-C','synthetic-C-refreshed']);
  checks.push('HTTP 401 requests external refresh and retries with returned token');
  refreshAccount='D'; requests.length=0; rejectNext=true; await turn(a,ta);
  assert.equal(refreshRequests,2);
  assert.ok(requests.some(request=>request.accountId==='D' && request.subject==='synthetic-D-refreshed'));
  checks.push('Protocol permits a different account in a 401 refresh response; production adapter intentionally does not enable this policy');
  if(process.env.G1_QUOTA==='1') {
    quotaNext=true;
    await assert.rejects(turn(a,ta),/failed/);
    const history=await a.call('thread/turns/list',{threadId:ta,limit:1,sortDirection:'desc',itemsView:'full'});
    const failed=history.data[0];
    console.log('Synthetic failed turn',JSON.stringify(failed)); console.log('Synthetic failed thread status',JSON.stringify((await a.call('thread/read',{threadId:ta,includeTurns:false})).thread.status));
    assert.equal(failed.status,'failed');
    assert.ok(failed.items.every(item=>item.type==='userMessage'));
    checks.push('429 usage rejection preserves failed turn and userMessage-only full history');
  }
  assert.equal(await readFile(path.join(home,'config.toml'),'utf8'),config);
  assert.equal(await readFile(path.join(home,'skills/g1-sentinel/SKILL.md'),'utf8'),skill);
  await assert.rejects(access(path.join(home,'auth.json')));
  checks.push('Shared config and skill unchanged; no auth.json written');
  if(process.env.G1_ADAPTER==='1') {
    const {CodexSession}=await import('../src/runtime/codex.mjs');
    const {default:WS}=await import('ws');
    const previousHome=process.env.CODEX_HOME;
    process.env.CODEX_HOME=home;
    try {
      const states=[]; let output='';
      const adapter=new CodexSession({id:'synthetic-adapter',cwd:home,codexPath:executable,accountId:'C',getPolicy:()=>({pinned:false,autoRecovery:true}),accounts:{choose:({exclude})=>exclude.includes('F')?null:'F',list:()=>[{id:'E',usage:{ordinaryUsageAllowed:true,windows:[]}},{id:'F',usage:{ordinaryUsageAllowed:true,windows:[]}}],getAuth:async id=>({accessToken:jwt(id),chatgptAccountId:id,chatgptPlanType:'pro'}),refresh:async()=>({accessToken:jwt('C-refreshed'),chatgptAccountId:'C',chatgptPlanType:'pro'}),updateUsage(){}},onState:state=>states.push(state),onOutput:data=>{output=(output+data).slice(-20000);if(data.includes('\x1b[6n'))adapter.input('\x1b[1;1R');}});
      adapters.push(adapter); await adapter.start();
      const unauthenticated=new WS(adapter.url);
      const rejected=await new Promise(resolve=>{unauthenticated.once('open',()=>resolve(false));unauthenticated.once('error',()=>resolve(true));});
      unauthenticated.terminate();assert.equal(rejected,true);
      for(let i=0;i<150 && !output.includes('mock-model');i++){if(output.includes('Do you trust the contents')){output='';adapter.input('\r');}await new Promise(resolve=>setTimeout(resolve,100));}
      assert.ok(output.includes('mock-model'),`Adapter TUI startup failed: ${output.slice(-1500)}`);
      await new Promise(resolve=>setTimeout(resolve,500));
      requests.length=0; states.length=0;
      adapter.input('Reply briefly.'); await new Promise(resolve=>setTimeout(resolve,100)); adapter.input('\r');
      for(let i=0;i<200 && !states.some(state=>state.turnOutcome==='completed');i++)await new Promise(resolve=>setTimeout(resolve,100));
      assert.ok(requests.some(request=>request.accountId==='C'),`No model request from terminal; output: ${output.slice(-2000)}`);
      assert.ok(states.some(state=>state.status==='running'),JSON.stringify(states));
      assert.ok(states.some(state=>state.turnOutcome==='completed'),JSON.stringify(states)+' '+output.slice(-3000));
      await adapter.switchAccount('E'); assert.equal(adapter.accountId,'E'); checks.push('Production adapter switches account at an authoritative idle boundary');
      requests.length=0;states.length=0;quotaNext=true;quotaThread=adapter.threadId; adapter.input('Recover this synthetic request.'); await new Promise(resolve=>setTimeout(resolve,100)); adapter.input('\r');
      for(let i=0;i<250 && !states.some(state=>state.turnOutcome==='completed');i++)await new Promise(resolve=>setTimeout(resolve,100));
      assert.ok(requests.some(request=>request.accountId==='E'));assert.ok(requests.some(request=>request.accountId==='F'),JSON.stringify(states)+' '+output.slice(-5000));assert.ok(states.some(state=>state.turnOutcome==='completed'),JSON.stringify(states));checks.push('Production adapter retries pure-text pre-execution quota failure on F through the original TUI and completes');
      checks.push('Production adapter rejects unauthenticated WS clients and PTY keyboard prompt produces C request, running state, and completed outcome');
    } finally { if(previousHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previousHome; }
  }
  const sentinel='synthetic shared auth sentinel: must remain byte-for-byte unchanged\n';
  await writeFile(path.join(home,'auth.json'),sentinel);
  await assert.rejects(a.call('account/login/start',{type:'apiKey',apiKey:'synthetic-blocked-key'}),/External auth is active/);
  await a.call('account/logout');
  assert.equal(await readFile(path.join(home,'auth.json'),'utf8'),sentinel);
  assert.equal((await a.call('account/read',{refreshToken:false})).account,null);
  if(adapters.length) {
    const adapter=adapters[0];await adapter.call('account/logout');
    for(let i=0;i<100 && adapter.accountId!==null;i++)await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(adapter.accountId,null);assert.equal(adapter.pendingRecovery,null);
    assert.equal(await readFile(path.join(home,'auth.json'),'utf8'),sentinel);
  }
  checks.push('Ephemeral auth override prevents native logout from modifying shared auth.json and clears managed account badge without automatic relogin');
  result={status:'PASS',testedAt:new Date().toISOString(),checks,limitations:['Synthetic local HTTP provider; no real subscription or quota tested',...(adapters.length?['Production adapter keyboard and observer coexistence tested']:terminals.length?['TUI attachment and refresh coexistence tested; terminal keyboard submission not asserted']:['Remote TUI coexistence not tested by this experiment']),'External chatgptAuthTokens API is unstable and marked internal by Codex schema']};
} catch(error) {
  result={status:'FAIL',testedAt:new Date().toISOString(),checks,error:error.stack};
  process.exitCode=1;
} finally {
  for(const client of clients)client.socket.close();
  for(const adapter of adapters)await adapter.stop();
  for(const terminal of terminals)terminal.kill();
  for(const child of children)child.kill();
  await Promise.all(children.map(child=>child.exitCode!==null?null:new Promise(resolve=>{child.once('exit',resolve);setTimeout(resolve,3000).unref();})));
  await new Promise(resolve=>server.close(resolve));
  await rm(home,{recursive:true,force:true,maxRetries:3});
}
await writeFile(fileURLToPath(new URL('./g1-results.json',import.meta.url)),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
