import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexSession, mapThreadStatus, recoveryText, isTerminalResponse } from '../src/runtime/codex.mjs';

test('protocol state preserves approval and user input over active work',()=>{
  assert.equal(mapThreadStatus({type:'active',activeFlags:['waitingOnApproval']}),'approval');
  assert.equal(mapThreadStatus({type:'active',activeFlags:['waitingOnUserInput']}),'input');
  assert.equal(mapThreadStatus({type:'active',activeFlags:[]}),'running');
  assert.equal(mapThreadStatus({type:'notLoaded'}),'unknown');
});

test('account switching is rejected while a turn or approval is active',async()=>{
  let reads=0;
  const session=new CodexSession({accounts:{getAuth(){reads++;}},accountId:'A'});
  for(const status of ['running','approval','input','unknown','starting']){
    session.status=status;
    await assert.rejects(session.switchAccount('B'),/턴이 끝난 뒤/);
  }
  assert.equal(reads,0);
});

test('cancel while credentials load prevents a late authentication write',async()=>{
  let release, writes=0;
  const session=new CodexSession({accounts:{getAuth:()=>new Promise(resolve=>{release=resolve;})}});
  session.call=async()=>{writes++;};
  const pending=session.login('B');
  await session.stop();
  release({accessToken:'synthetic',chatgptAccountId:'B'});
  await assert.rejects(pending,/stopped/);
  assert.equal(writes,0);
});

test('background title generation and child threads cannot replace the visible session',async()=>{
  const session=new CodexSession({});
  const started=thread=>session.receive(JSON.stringify({method:'thread/started',params:{thread}}));
  await started({id:'visible',status:{type:'idle'},source:'vscode',ephemeral:false});
  await started({id:'title',status:{type:'idle'},source:'vscode',ephemeral:true});
  await started({id:'child',status:{type:'idle'},parentThreadId:'visible',source:'vscode'});
  assert.equal(session.threadId,'visible');
});

test('late usage lookup cannot switch an account after a turn has started',async()=>{
  let release; const calls=[];
  const session=new CodexSession({accounts:{getAuth:()=>new Promise(resolve=>{release=resolve;})}});
  session.threadId='root';session.status='idle';
  session.call=async method=>{calls.push(method);return {thread:{status:{type:'active'}}};};
  const switching=session.switchAccount('B');
  assert.throws(()=>session.input('prompt'),/계정 전환/);
  session.status='running';release({accessToken:'synthetic'});
  await assert.rejects(switching,/턴이 끝난 뒤/);
  assert.deepEqual(calls,['thread/read']);
});

test('idle existing session reports the account only after Codex confirms the applied identity',async()=>{
  const states=[]; const calls=[];
  const session=new CodexSession({accountId:'A',now:()=>1234,onState:state=>states.push(state),accounts:{getAuth:async()=>({accessToken:'token-b',chatgptAccountId:'remote-b',chatgptPlanType:'pro'}),list:()=>[{id:'B',email:'b@example.invalid'}]}});
  session.threadId='root';session.status='idle';
  session.call=async(method,params)=>{calls.push({method,params});if(method==='thread/read')return {thread:{status:{type:'idle'}}};if(method==='account/read')return {account:{type:'chatgpt',email:'b@example.invalid'}};return {};};
  await session.switchAccount('B');
  assert.equal(calls[1].method,'account/login/start');assert.equal(calls[1].params.accessToken,'token-b');assert.equal(calls.at(-1).method,'account/read');
  assert.equal(session.accountId,'B');assert.equal(session.chatgptAccountId,'remote-b');
  assert.deepEqual(states.at(-1),{accountId:'B',accountState:'applied',accountVerification:'identity',accountAppliedAt:1234});
});

test('account identity mismatch clears the displayed account rather than lying about the applied identity',async()=>{
  const session=new CodexSession({accountId:'A',accounts:{getAuth:async()=>({accessToken:'token-b',chatgptAccountId:'remote-b'}),list:()=>[{id:'B',email:'b@example.invalid'}]}});
  session.threadId='root';session.status='idle';
  session.call=async method=>method==='thread/read'?{thread:{status:{type:'idle'}}}:method==='account/read'?{account:{type:'chatgpt',email:'other@example.invalid'}}:{};
  await assert.rejects(session.switchAccount('B'),/다른 계정/);
  assert.equal(session.accountId,null);
});

test('lost login response clears the previous applied-account claim',async()=>{
  const states=[]; const session=new CodexSession({accountId:'A',onState:state=>states.push(state),accounts:{getAuth:async()=>({accessToken:'token-b',chatgptAccountId:'remote-b'})}});
  session.threadId='root';session.status='idle';
  session.call=async method=>{if(method==='thread/read')return {thread:{status:{type:'idle'}}};throw new Error('Codex connection closed');};
  await assert.rejects(session.switchAccount('B'),/connection closed/);
  assert.equal(session.accountId,null);assert.equal(states.at(-1).accountState,'failed');
});

test('same turn outcome is reported once across notification and later idle lookup',()=>{
  const states=[]; const session=new CodexSession({onState:state=>states.push(state)});
  session.reportOutcome({id:'turn-1',status:'completed'});
  session.reportOutcome({id:'turn-1',status:'completed'});
  assert.equal(states.length,1);assert.equal(states[0].turnId,'turn-1');
});

const failedTurn=()=>({id:'failed-1',status:'failed',itemsView:'full',error:{codexErrorInfo:'usageLimitExceeded'},items:[{type:'userMessage',content:[{type:'text',text:'original prompt',text_elements:[]}]}]});

test('recovery refuses tool output, missing history, unknown failures and terminal escape text',()=>{
  assert.equal(recoveryText(failedTurn()),'original prompt');
  const tool=failedTurn();tool.items.push({type:'commandExecution'});assert.equal(recoveryText(tool),null);
  const missing=failedTurn();missing.itemsView='summary';assert.equal(recoveryText(missing),null);
  const unknown=failedTurn();unknown.error.codexErrorInfo='other';assert.equal(recoveryText(unknown),null);
  const escape=failedTurn();escape.items[0].content[0].text='\x1b[201~attack';assert.equal(recoveryText(escape),null);
});

test('pinned recovery waits for its own account without selecting another',async()=>{
  let choice;const session=new CodexSession({accountId:'A',getPolicy:()=>({pinned:true,autoRecovery:true}),accounts:{list:()=>[],choose:options=>{choice=options;return null;}}});
  session.status='error';session.threadId='root';
  await session.prepareRecovery(failedTurn());
  assert.equal(choice.pinnedId,'A');assert.deepEqual(choice.exclude,['A']);assert.equal(session.status,'waiting');
});

test('user input cancels recovery during credential lookup before account mutation',async()=>{
  let release;const writes=[], calls=[];
  const session=new CodexSession({accountId:'A',getPolicy:()=>({pinned:false,autoRecovery:true}),accounts:{list:()=>[],choose:()=> 'B',getAuth:()=>new Promise(resolve=>{release=resolve;})}});
  session.status='error';session.threadId='root';session.terminal={write:data=>writes.push(data)};
  session.call=async method=>{calls.push(method);return {};};
  const recovery=session.prepareRecovery(failedTurn());
  await new Promise(resolve=>setImmediate(resolve));
  session.input('user change'); release({accessToken:'synthetic'});await recovery;
  assert.deepEqual(writes,['user change']);assert.deepEqual(calls,[]);assert.equal(session.pendingRecovery,null);
});

test('temporary capacity failures retry with bounded exponential cooldown',()=>{
  let now=1000; const session=new CodexSession({now:()=>now,accounts:{list:()=>[{id:'A',status:'ready'}]}});
  const pending={tried:new Map()};
  session.recordRecoveryFailure(pending,'A','transient');
  assert.deepEqual(session.recoveryExclusions(pending),['A']);
  now+=30000;assert.deepEqual(session.recoveryExclusions(pending),[]);
  session.recordRecoveryFailure(pending,'A','transient');
  now+=30000;assert.deepEqual(session.recoveryExclusions(pending),['A']);
  now+=30000;assert.deepEqual(session.recoveryExclusions(pending),[]);
  for(let i=0;i<10;i++)session.recordRecoveryFailure(pending,'A','transient');
  assert.equal(pending.tried.get('A').retryAt-now,300000);
});

test('quota failures wait for changed quota snapshot even after transient cooldown',()=>{
  let now=0,resetAt=10000;
  const session=new CodexSession({now:()=>now,accounts:{list:()=>[{id:'A',status:'ready',usage:{ordinaryUsageAllowed:false,windows:[{resetAt}]}}]}});
  const pending={tried:new Map()};session.recordRecoveryFailure(pending,'A','quota');
  now=99999999;assert.deepEqual(session.recoveryExclusions(pending),['A']);
  resetAt=20000;assert.deepEqual(session.recoveryExclusions(pending),[]);
});

test('reauth-required failures remain excluded until fresh import restores ready status',()=>{
  let now=0,status='reauth_required';
  const session=new CodexSession({now:()=>now,accounts:{list:()=>[{id:'A',status}]}});
  const pending={tried:new Map()};session.recordRecoveryFailure(pending,'A','transient');
  now=99999999;assert.deepEqual(session.recoveryExclusions(pending),['A']);
  status='ready';assert.deepEqual(session.recoveryExclusions(pending),[]);
});

test('cancel after recovery paste never submits Enter and reports the remaining draft',async()=>{
  const writes=[], states=[];
  const session=new CodexSession({accountId:'A',onState:state=>states.push(state),getPolicy:()=>({pinned:false,autoRecovery:true}),accounts:{list:()=>[],choose:()=> 'B'}});
  session.status='error';session.threadId='root';session.switchAccount=async()=>{};
  session.terminal={write:data=>{writes.push(data);session.cancelRecovery();}};
  await session.prepareRecovery(failedTurn());
  assert.equal(writes.length,1);assert.ok(writes[0].endsWith('\x1b[201~'));assert.equal(session.pendingRecovery,null);
  assert.ok(states.some(state=>state.status==='error' && state.detail.includes('초안')));
});

test('terminal CPR and device replies preserve recovery while real or mixed input cancels it',()=>{
  const writes=[]; const session=new CodexSession({});session.terminal={write:data=>writes.push(data)};
  const pending={turnId:'pending'};session.pendingRecovery=pending;session.replayCommitting=true;
  session.input('\x1b[24;80R');session.input('\x1b[?1;2c');session.input('\x1b[>0;276;0c');
  assert.equal(session.pendingRecovery,pending);assert.equal(session.inputEpoch,0);assert.equal(writes.length,3);
  assert.equal(isTerminalResponse('\x1b[A'),false);assert.equal(isTerminalResponse('\x1b[1;1Ruser text'),false);
  session.replayCommitting=false;session.input('\x1b[A');assert.equal(session.pendingRecovery,null);assert.equal(session.inputEpoch,1);
});

test('native logout or login clears managed account label and cancels automatic recovery',async()=>{
  const states=[];const session=new CodexSession({accountId:'A',onState:state=>states.push(state)});
  session.chatgptAccountId='remote-A';session.pendingRecovery={turnId:'pending'};
  await session.receive(JSON.stringify({method:'account/updated',params:{authMode:null}}));
  assert.equal(session.accountId,null);assert.equal(session.chatgptAccountId,null);assert.equal(session.pendingRecovery,null);
  session.accountId='A';await session.receive(JSON.stringify({method:'account/updated',params:{authMode:'apikey'}}));
  assert.equal(session.accountId,null);assert.ok(states.at(-1).detail.includes('직접 로그인'));
});
