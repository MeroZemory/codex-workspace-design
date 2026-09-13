import { EventEmitter } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import WebSocket from 'ws';
import pty from 'node-pty';

const execute = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export function isTerminalResponse(data) {
  // CPR and primary/secondary device attributes only. Arrow keys, pasted text,
  // and mixed input are never classified as terminal protocol responses.
  return typeof data === 'string' && data.length <= 128 && /^\x1b\[(?:\d{1,4};\d{1,4}R|[?>]?[\d;]{1,64}c)$/.test(data);
}

export function recoveryText(turn) {
  if (turn?.status !== 'failed' || turn.itemsView !== 'full' || !['usageLimitExceeded','unauthorized','serverOverloaded','rateLimitExceeded'].includes(turn.error?.codexErrorInfo)) return null;
  if (turn.items?.length !== 1 || turn.items[0].type !== 'userMessage') return null;
  const content = turn.items[0].content;
  if (!content?.length || content.some(item=>item.type !== 'text' || item.text_elements?.length || typeof item.text !== 'string')) return null;
  const text = content.map(item=>item.text).join('\n');
  return text && text.length <= 100000 && !/[\x00-\x08\x0b-\x1f\x7f]/.test(text) ? text : null;
}

export function mapThreadStatus(status) {
  if (status?.type === 'active') {
    if (status.activeFlags?.includes('waitingOnApproval')) return 'approval';
    if (status.activeFlags?.includes('waitingOnUserInput')) return 'input';
    return 'running';
  }
  return ({ idle:'idle', systemError:'error', notLoaded:'unknown' })[status?.type] || 'unknown';
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

// This integration deliberately gates the unstable external-auth protocol to the
// installed version used in the synthetic two-account compatibility experiment.
export class CodexSession extends EventEmitter {
  constructor({ id, cwd, resumeId, codexPath, accounts, accountId, now = Date.now, getPolicy = () => ({pinned:true,autoRecovery:false}), onState = () => {}, onOutput = () => {} }) {
    super();
    Object.assign(this, { id, cwd, resumeId, codexPath, accounts, accountId, now, getPolicy, onState, onOutput });
    this.pending = new Map(); this.seq = 0; this.status = 'starting'; this.stopped = false; this.threadId = resumeId || null;
    this.outcomes = new Set(); this.activity = 0; this.authBusy = false;
    this.inputEpoch = 0; this.turnInputEpoch = 0; this.recoveryEpoch = 0;
  }
  state(patch) {
    if (this.stopped) return;
    if (patch.status) this.status = patch.status;
    this.onState(patch); this.emit('state', patch);
  }
  ensureAlive() { if (this.stopped) throw new Error('Session was stopped'); }
  async start() {
    try {
      this.ensureAlive();
      const { stdout } = await execute(this.codexPath, ['--version'], { windowsHide:true, timeout:5000 });
      if (!/^codex-cli 0\.154\.0\s*$/.test(stdout.trim())) throw new Error(`지원 검증된 Codex CLI 버전은 0.154.0입니다. 설치 버전: ${stdout.trim()}`);
      this.ensureAlive();
      const token = randomBytes(32).toString('base64url');
      const digest = createHash('sha256').update(token).digest('hex');
      for (let attempt = 0; attempt < 3; attempt++) {
        this.ensureAlive();
        this.url = `ws://127.0.0.1:${await freePort()}`;
        this.ensureAlive();
        const child = spawn(this.codexPath, ['app-server','-c','cli_auth_credentials_store="ephemeral"','--listen',this.url,'--ws-auth','capability-token','--ws-token-sha256',digest], {cwd:this.cwd, windowsHide:true, stdio:['ignore','ignore','pipe']});
        this.child = child; let stderr = '', exited = false;
        child.stderr.on('data', data => { stderr = (stderr + data).slice(-1000); });
        child.on('error', () => { exited = true; });
        child.on('exit', () => { exited = true; if (this.connected && this.child === child && !this.stopped) this.state({status:'error',detail:'Codex 실행 서버가 종료되었습니다.'}); });
        try {
          this.socket = await this.connect(this.url, token, () => exited);
          break;
        } catch (error) {
          if (child.exitCode === null) child.kill();
          if (attempt === 2 || !/address.*in use|os error 10048/i.test(stderr)) throw error;
        }
      }
      this.ensureAlive(); this.connected = true;
      const requestedAccountId=this.accountId;
      await this.call('initialize',{clientInfo:{name:'codex_workspace_runtime',title:'Codex Workspace',version:'0.1.1'},capabilities:{experimentalApi:true}});
      this.socket.send(JSON.stringify({method:'initialized'}));
      if (requestedAccountId) await this.login(requestedAccountId);
      this.ensureAlive();
      // TUI creates/resumes its own thread so that it retains approval ownership.
      const args = ['-c','cli_auth_credentials_store="ephemeral"','--remote',this.url,'--remote-auth-token-env','CODEX_WORKSPACE_REMOTE_TOKEN','--cd',this.cwd];
      if (this.resumeId) args.push('resume',this.resumeId);
      this.terminal = pty.spawn(this.codexPath, args, {name:'xterm-256color',cols:100,rows:30,cwd:this.cwd,env:{...process.env,TERM:'xterm-256color',CODEX_WORKSPACE_REMOTE_TOKEN:token}});
      this.terminal.onData(data => { if (!this.stopped) this.onOutput(data); });
      this.terminal.onExit(({exitCode}) => { if (!this.stopped) this.state({status:exitCode === 0 ? 'stopped':'error',detail:`Codex 터미널 종료 (${exitCode})`}); });
      this.state({status:'starting',detail:'Codex 터미널 연결 중'});
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
  async connect(url, token, exited) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      this.ensureAlive();
      if (exited()) throw new Error('Codex app-server를 시작하지 못했습니다.');
      const socket = new WebSocket(url,{headers:{Authorization:`Bearer ${token}`},handshakeTimeout:1200,maxPayload:16*1024*1024});
      const opened = await new Promise(resolve => {
        socket.once('open',()=>resolve(true));
        socket.once('error',()=>resolve(false));
      });
      if (!opened) { socket.terminate(); await delay(100); continue; }
      if (this.stopped) { socket.terminate(); this.ensureAlive(); }
      socket.on('message', data => { this.receive(data).catch(() => this.state({status:'error',detail:'Codex 프로토콜 응답을 처리하지 못했습니다.'})); });
      socket.on('error',()=>{});
      socket.on('close',()=>{
        for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('Codex connection closed')); }
        this.pending.clear();
        if (!this.stopped) this.state({status:'unknown',detail:'Codex 상태 연결이 끊겼습니다.'});
      });
      return socket;
    }
    throw new Error('Codex app-server 연결 시간이 초과되었습니다.');
  }
  call(method, params = {}) {
    this.ensureAlive();
    if (this.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Codex is not connected'));
    return new Promise((resolve,reject)=>{
      const id = ++this.seq;
      const timer = setTimeout(()=>{this.pending.delete(id);reject(new Error(`Codex 요청 시간 초과: ${method}`));},15000);
      this.pending.set(id,{resolve,reject,timer});
      this.socket.send(JSON.stringify({id,method,params}));
    });
  }
  async receive(data) {
    const message = JSON.parse(data.toString());
    if (!message.method) {
      const item = this.pending.get(message.id);
      if (!item) return;
      this.pending.delete(message.id); clearTimeout(item.timer);
      if (message.error) item.reject(new Error(message.error.message || 'Codex request failed')); else item.resolve(message.result);
      return;
    }
    const { method, params = {} } = message;
    if(method === 'account/updated' && params.authMode !== 'chatgptAuthTokens') {
      this.cancelRecovery(); this.accountId=null; this.chatgptAccountId=null;
      this.state({accountId:null,accountState:'unmanaged',accountVerification:null,accountAppliedAt:null,status:'error',detail:params.authMode?'CLI에서 직접 로그인했습니다. 앱에서 관리할 계정을 다시 선택하세요.':'CLI에서 로그아웃했습니다. 앱 계정을 다시 선택하기 전까지 자동 복구하지 않습니다.'});
      return;
    }
    if (method === 'account/chatgptAuthTokens/refresh') {
      const accountId = this.accountId;
      try {
        if (!accountId || this.authBusy || (params.previousAccountId && params.previousAccountId !== this.chatgptAccountId)) throw new Error('Account changed');
        const auth = await this.accounts.refresh(accountId);
        this.ensureAlive();
        if (accountId !== this.accountId || auth.chatgptAccountId !== this.chatgptAccountId) throw new Error('Account changed during refresh');
        this.socket.send(JSON.stringify({id:message.id,result:auth}));
      } catch {
        if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({id:message.id,error:{code:-32000,message:'Account refresh unavailable; check account status'}}));
        this.state({status:'waiting',detail:'계정 인증을 갱신하지 못했습니다. 계정 상태를 확인하세요.'});
      }
      return;
    }
    // Approval/input requests belong to the TUI. The observer never answers them.
    if (method === 'thread/started') {
      if (params.thread.ephemeral || params.thread.parentThreadId) return;
      if (params.thread.source && typeof params.thread.source === 'object' && 'subAgent' in params.thread.source) return;
      this.threadId = params.thread.id;
      this.state({threadId:this.threadId,status:mapThreadStatus(params.thread.status),detail:''});
    }
    if (params.threadId && this.threadId && params.threadId !== this.threadId) return;
    if (method === 'thread/status/changed') {
      this.activity++;
      if(params.status.type === 'active' && this.pendingRecovery?.submitted) {
        this.pendingRecovery.submissionObserved=true;
        clearTimeout(this.submissionTimer);
      }
      if (params.status.type === 'active' && !['running','approval','input'].includes(this.status)) this.turnInputEpoch = this.inputEpoch;
      this.state({threadId:params.threadId,status:mapThreadStatus(params.status),detail:''});
      if (['idle','systemError'].includes(params.status.type)) this.readOutcome().catch(()=>this.state({detail:'최근 턴 결과를 확인하지 못했습니다.'}));
    }
    if (method === 'turn/completed') { this.reportOutcome(params.turn); if(params.turn.status === 'failed') this.readOutcome().catch(()=>this.state({detail:'자동 복구 조건을 확인하지 못했습니다.'})); }
    if (method === 'account/rateLimits/updated' && this.accountId) await this.accounts?.updateUsage(this.accountId,params);
  }
  reportOutcome(turn) {
    if (!turn.id || this.outcomes.has(turn.id)) return;
    this.outcomes.add(turn.id);
    if (this.outcomes.size > 1000) this.outcomes.delete(this.outcomes.values().next().value);
    this.state({turnId:turn.id,turnOutcome:turn.status,detail:turn.status === 'failed'?'Codex 턴이 실패했습니다. 터미널에서 상세 내용을 확인하세요.':''});
  }
  async readOutcome() {
    if (!this.threadId) return;
    const activity = this.activity, threadId = this.threadId;
    // Status broadcasts precede persisted turn finalization on the observer
    // connection. Let the final record settle before assigning an outcome.
    await delay(150);
    if(this.stopped || activity !== this.activity || threadId !== this.threadId) return;
    const result = await this.call('thread/turns/list',{threadId:this.threadId,limit:1,sortDirection:'desc',itemsView:'full'});
    const turn = result.data?.[0];
    if (turn && ['idle','error'].includes(this.status) && this.activity === activity && this.threadId === threadId) {
      this.reportOutcome(turn);
      if(turn.status === 'failed') await this.prepareRecovery(turn);
      else if(turn.status === 'completed') this.pendingRecovery = null;
    }
  }
  async login(id) {
    const auth = await this.accounts.getAuth(id);
    this.ensureAlive();
    await this.activateAccount(id, auth);
  }
  async activateAccount(id, auth) {
    this.state({accountState:'applying',accountVerification:null});
    try {
      await this.call('account/login/start',{type:'chatgptAuthTokens',...auth});
      const verification = await this.verifyAccount(id);
      this.ensureAlive(); this.accountId = id; this.chatgptAccountId = auth.chatgptAccountId;
      this.state({accountId:id,accountState:'applied',accountVerification:verification,accountAppliedAt:this.now()});
    } catch (error) {
      this.accountId = null; this.chatgptAccountId = null;
      this.state({accountId:null,accountState:'failed',accountVerification:null,accountAppliedAt:null,detail:error.message});
      throw error;
    }
  }
  async verifyAccount(id) {
    const result = await this.call('account/read',{refreshToken:false});
    if (result.account?.type !== 'chatgpt') throw new Error('Codex에 적용된 ChatGPT 계정을 확인하지 못했습니다.');
    const expected = this.accounts.list?.().find(account => account.id === id)?.email;
    if (expected && result.account.email && expected.toLowerCase() !== result.account.email.toLowerCase()) throw new Error('Codex에 다른 계정이 적용되어 전환을 중단했습니다.');
    return expected && result.account.email ? 'identity' : 'accepted';
  }
  async switchAccount(id, isValid = () => true) {
    if (this.authBusy || !['idle','waiting','error'].includes(this.status)) throw new Error('턴이 끝난 뒤 계정을 전환할 수 있습니다.');
    this.authBusy = true;
    try {
      const auth = await this.accounts.getAuth(id);
      this.ensureAlive();
      if(!isValid()) throw new Error('Account switch cancelled');
      if (!this.threadId) throw new Error('Codex 대화가 아직 준비되지 않았습니다.');
      const activity = this.activity;
      const {thread} = await this.call('thread/read',{threadId:this.threadId,includeTurns:false});
      if (thread.status?.type === 'systemError') {
        const recent=await this.call('thread/turns/list',{threadId:this.threadId,limit:1,sortDirection:'desc',itemsView:'notLoaded'});
        if (recent.data?.[0]?.status !== 'failed') throw new Error('Codex 턴 종료를 확인하지 못했습니다.');
      } else if (thread.status?.type !== 'idle') throw new Error('턴이 끝난 뒤 계정을 전환할 수 있습니다.');
      if (activity !== this.activity || ['running','approval','input'].includes(this.status)) throw new Error('턴이 끝난 뒤 계정을 전환할 수 있습니다.');
      if(!isValid()) throw new Error('Account switch cancelled');
      this.loginInFlight = true;
      await this.activateAccount(id, auth);
    } finally { this.authBusy = false; this.loginInFlight = false; }
  }
  async getUsage() { return this.call('account/rateLimits/read'); }
  usageSignature(id) {
    const usage=this.accounts.list?.().find(account=>account.id === id)?.usage;
    return JSON.stringify([usage?.ordinaryUsageAllowed,(usage?.windows || []).map(window=>window.resetAt)]);
  }
  recordRecoveryFailure(pending, id, kind) {
    const previous=pending.tried.get(id), count=(previous?.count || 0)+1;
    const status=this.accounts.list?.().find(account=>account.id === id)?.status;
    pending.tried.set(id,{kind:status === 'reauth_required'?'reauth':kind,count,signature:this.usageSignature(id),retryAt:this.now()+Math.min(300000,30000*2**Math.min(count-1,4))});
  }
  recoveryExclusions(pending) {
    return [...pending.tried].filter(([id,attempt])=>{
      const status=this.accounts.list?.().find(account=>account.id === id)?.status;
      if(status === 'reauth_required') return true;
      if(attempt.kind === 'reauth') return status !== 'ready';
      if(attempt.kind === 'quota') return this.usageSignature(id) === attempt.signature;
      return this.now() < attempt.retryAt;
    }).map(([id])=>id);
  }
  async prepareRecovery(turn) {
    if(!this.accountId || !this.getPolicy().autoRecovery || this.recoveryBusy || this.pendingRecovery?.turnId === turn.id) return;
    const text=recoveryText(turn);
    if(!text || this.inputEpoch !== this.turnInputEpoch) { this.state({detail:'실행 전 실패임을 확인할 수 없어 자동 재시도하지 않았습니다. 터미널을 확인하세요.'});return; }
    const previous=this.pendingRecovery;
    this.pendingRecovery={turnId:turn.id,text,tried:previous?.tried || new Map(),inputEpoch:this.inputEpoch,threadId:this.threadId};
    this.recordRecoveryFailure(this.pendingRecovery,this.accountId,turn.error.codexErrorInfo === 'usageLimitExceeded'?'quota':'transient');
    await this.wakeRecovery();
  }
  cancelRecovery() { this.recoveryEpoch++; this.pendingRecovery=null; clearTimeout(this.submissionTimer); }
  async wakeRecovery() {
    const pending=this.pendingRecovery, policy=this.getPolicy(), epoch=this.recoveryEpoch;
    if(!this.accountId || !pending || pending.submitted || this.recoveryBusy || this.stopped || !policy.autoRecovery) return;
    const valid=()=>!this.stopped && this.recoveryEpoch === epoch && this.pendingRecovery === pending && this.inputEpoch === pending.inputEpoch && this.threadId === pending.threadId && this.getPolicy().autoRecovery && this.getPolicy().pinned === policy.pinned && this.getPolicy().generation === policy.generation;
    this.recoveryBusy=true;
    let next;
    try {
      if(!valid()) return;
      const exclude=this.recoveryExclusions(pending);
      next=await this.accounts.choose({exclude,...(policy.pinned?{pinnedId:this.accountId}:{})});
      if(!valid()) return;
      if(!next) { this.state({status:'waiting',detail:policy.pinned?'고정 계정의 사용량 갱신을 기다립니다.':'사용 가능한 계정이 생기면 실행 전 실패한 입력을 다시 시도합니다.'});return; }
      // A native completed failure is required even when UI status says waiting.
      this.state({status:'waiting',detail:'실행 전 실패를 다른 계정에서 복구하는 중입니다.'});
      this.recoveringAuth=true;
      await this.switchAccount(next,valid);
      this.recoveringAuth=false;
      if(!valid()) return;
      // No synthetic keypress is sent after any intervening user input/cancel.
      pending.submitted=true;
      this.replayCommitting=true;
      this.terminal.write(`\x1b[200~${pending.text}\x1b[201~`);
      await delay(100);
      if(!valid()) { this.state({status:'error',detail:'자동 제출을 취소했습니다. 입력란의 초안을 확인하세요.'});return; }
      this.terminal.write('\r');
      this.state({status:'recovering',detail:'실행 전 거절된 입력을 다시 요청했습니다.'});
      this.submissionTimer=setTimeout(()=>{
        if(valid() && !pending.submissionObserved) {
          this.cancelRecovery();
          this.state({status:'error',detail:'재시도 시작을 확인하지 못했습니다. 중복 제출을 피하기 위해 자동 재시도를 멈췄습니다. 터미널을 확인하세요.'});
        }
      },5000);
      this.submissionTimer.unref();
    } catch {
      if(valid()) {
        if(this.replayCommitting) {
          this.cancelRecovery();
          this.state({status:'error',detail:'복구 입력의 전송 여부를 확인하지 못했습니다. 자동 제출을 멈췄으니 터미널을 확인하세요.'});
        } else {
          if(next) this.recordRecoveryFailure(pending,next,'transient');
          this.state({status:'waiting',detail:'자동 복구를 완료하지 못했습니다. 잠시 후 계정 상태를 다시 확인합니다.'});
        }
      }
    } finally { this.recoveryBusy=false; this.replayCommitting=false; this.recoveringAuth=false; }
  }
  protocolInput(data) { this.ensureAlive(); if(!isTerminalResponse(data)) throw new Error('Unsupported terminal protocol response'); this.terminal?.write(data); }
  input(data) { this.ensureAlive(); if(isTerminalResponse(data)) return this.protocolInput(data); if(this.replayCommitting || this.loginInFlight || (this.authBusy && !this.recoveringAuth)) throw new Error('계정 전환 및 복구 입력 전송을 마친 뒤 입력할 수 있습니다.'); this.inputEpoch++; this.cancelRecovery(); this.terminal?.write(data); }
  resize(cols,rows) { this.ensureAlive(); this.terminal?.resize(cols,rows); }
  async stop() {
    if (this.stopped) return;
    this.stopped = true; this.connected = false;
    this.cancelRecovery();
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('Session stopped')); }
    this.pending.clear(); this.socket?.terminate();
    if (this.terminal) { try { this.terminal.kill(); } catch { /* PTY may already have exited. */ } }
    if (this.child && this.child.exitCode === null) {
      const child = this.child;
      await new Promise(resolve=>{child.once('exit',resolve);child.kill();setTimeout(resolve,3000).unref();});
    }
  }
}
