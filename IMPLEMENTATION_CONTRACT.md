# Implementation contract (v0.1)

Existing requirements and runtime architecture govern. JavaScript ESM runtime, Electron secure preload, xterm.js views. Display name is provisional. No real credentials used in automated tests.

## Renderer bridge

`window.workspace.invoke(method, params = {}) -> Promise<result>`; `window.workspace.onEvent(listener) -> unsubscribe`.
`snapshot` returns `{ sessions, accounts, workspace: {tabs,activeTabId}, runtime: {version, codexPath}, error? }`.
Sessions: `{id,title,cwd,threadId,accountId,pinned,status,detail,unread,reviewNeeded,cols,rows,generation}`. Status: `starting`, `running`, `approval`, `input`, `idle`, `recovering`, `waiting`, `error`, `unknown`, `stopped`.
Accounts: public metadata only `{id,label,email,plan,status,usage,forecast,error?}`. No secrets.
Tabs: `{id,title,panels:[{id,sessionId}],columns:2}`. Renderer may store extra layout fields. Runtime validates bounded JSON.
Commands: `session.create {cwd,title?,accountId?,pinned?,resumeId?}`, `session.delete {id}`, `session.switch {id,accountId,pinned?}`, `session.pin {id,pinned}`, `session.review {id}`, `session.read {id}`, `session.cancelRecovery {id}`; `terminal.attach {id,viewId,cols,rows}` returns `{data,seq,cols,rows}`, `terminal.input {id,viewId,data}`, `terminal.resize {id,viewId,cols,rows}`; `workspace.save {tabs,activeTabId}`; `accounts.import` (desktop shows JSON file picker then runtime receives selected path), `accounts.refresh`, `folder.pick` (desktop); `runtime.shutdown` (requires no live sessions).
Events: `{type:'snapshot',data:snapshot}`, `{type:'terminal',id,data,seq}`, `{type:'error',message}`. Terminal output is canonical stream. Attach snapshot and live sequence prevent duplicate output. Hidden panels never resize. Owner chosen on focus/attach. Renderer saves views separately from sessions; delete confirms termination.

## Accounts module

`src/runtime/accounts.mjs` exports `AccountManager`. `new AccountManager({dataDir,onChange})`; `await init()`, `list()` sanitized, `importFile(path)`, `getAuth(id)` resolves `{accessToken,chatgptAccountId,chatgptPlanType}`, `refresh(id)` same auth shape with serialized durable refresh, `updateUsage(id,rateLimitsResponse)`, `choose({exclude:[],currentId?,pinnedId?})` account id or null. `setStatus(id,status,error?)`. `close()` optional. Never read/import live credentials automatically. DPAPI at rest Windows; unsupported secure platform fails clearly. Persist refresh-in-flight marker before request; unknown result quarantined. Forecast from quota snapshots, no token-based metering. Constructor injected fetch/crypto for meaningful synthetic tests allowed.

## Adapter module

`src/runtime/codex.mjs` exports `CodexSession` EventEmitter. Constructor `{id,cwd,resumeId,codexPath,accounts,accountId,onState,onOutput}`. `start()`, `input(data)`, `resize(cols,rows)`, `switchAccount(id)`, `getUsage()`, `stop()`. Own app-server and remote TUI PTY, connect runtime observer. onState partial `{status,detail,threadId,turnOutcome?}`; onOutput string. Authentication supplied externally without separate CODEX_HOME. Never replay prompt/tool input on failure. Automatic auth renewal only via native server refresh request. Account changes idle only; recovery limits documented. Parent handles canonical screen and lifecycle.
