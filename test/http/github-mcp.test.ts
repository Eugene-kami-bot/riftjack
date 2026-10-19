import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startGitHubMcp } from '../../src/github-mcp.js';
import { GitHubSubscriptions } from '../../src/github-subscriptions.js';
import { BackgroundTasks } from '../../src/background-tasks.js';
import { Bridge, sessionKey, type MatrixEvent } from '../../src/bridge.js';
import { createBackend } from '../../src/backends.js';
import { loadConfig } from '../../src/config.js';
import { State } from '../../src/state.js';

const input = { action: 'subscribe', repository: 'example/project', pull_requests: [1], events: ['pull_request'] };
test('GitHub MCP has scoped authentication and closes at the end of the task', async t => {
  const lifetime = new AbortController();
  let called = 0;
  const server = await startGitHubMcp(async () => { called++; return 'registered'; }, lifetime.signal);
  t.after(() => server.close());
  const post = (auth: string, id: number) => fetch(server.url, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'github_subscriptions', arguments: input } }) });
  assert.equal((await post('Bearer wrong', 1)).status, 401);
  assert.equal((await (await post(server.headers.Authorization, 2)).json()).result.content[0].text, 'registered');
  assert.ok((await (await post(server.headers.Authorization, 2)).json()).error);
  assert.equal(called, 1);
  lifetime.abort(); await server.close();
  await assert.rejects(post(server.headers.Authorization, 3));
});

for (const kind of ['codex', 'claude'] as const) test(`${kind} registers through MCP and resumes the same session after a PR change`, { timeout: 20_000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'background-mcp-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = join(root, 'cli.cjs');
  writeFileSync(cli, `#!/usr/bin/env node
const args=process.argv.slice(2);
const send=v=>console.log(JSON.stringify(v));
if (args.includes('--help')) { console.log('--input-format --output-format --permission-mode --permission-prompt-tool --append-system-prompt --tools --settings --resume'); process.exit(); }
if (args[0]==='auth') { send({loggedIn:true,authMethod:'claude.ai'}); process.exit(); }
let connection, resumed=false;
async function work(prompt) {
  if (prompt.includes('GitHub subscription event')) {
    if (!resumed) throw Error('Lost session');
    return 'Observed the saved result.';
  }
  const response=await fetch(connection.url,{method:'POST',headers:{...connection.headers,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:7,method:'tools/call',params:{name:'github_subscriptions',arguments:${JSON.stringify(input)}}})});
  const message=await response.json();
  if (message.result.isError) throw Error(message.result.content[0].text);
  return 'Subscription registered.';
}
require('node:readline').createInterface({input:process.stdin}).on('line',async line=>{
 try {
  const message=JSON.parse(line);
  if (args.includes('--mcp-config')) {
    connection=JSON.parse(args[args.indexOf('--mcp-config')+1]).mcpServers.riftjack_github;
    if (!args[args.indexOf('--allowedTools')+1].includes('mcp__riftjack_github__github_subscriptions')) throw Error('Tool not allowed');
    resumed=args.includes('--resume');
    send({type:'system',subtype:'init',session_id:'subscription-session'});
    const result=await work(message.message.content[0].text);
    send({type:'result',subtype:'success',result,session_id:'subscription-session'});
    return;
  }
  const {id,method,params:p}=message;
  const reply=result=>send({id,result});
  if (method==='initialize') reply({});
  if (method==='account/read') reply({account:{type:'chatgpt'}});
  if (method==='thread/start'||method==='thread/resume') {
    resumed=method==='thread/resume';
    const c=p.config['mcp_servers.riftjack_github'];
    if (!c.enabled_tools.includes('github_subscriptions')||c.tools.github_subscriptions.approval_mode!=='approve') throw Error('Tool policy');
    connection={url:c.url,headers:c.http_headers};
    reply({thread:{id:'subscription-session'}});
  }
  if (method==='thread/inject_items') reply({});
  if (method==='turn/start') {
    reply({turn:{id:'turn-1',status:'inProgress'}});
    const text=await work(p.input[0].text);
    send({method:'turn/completed',params:{threadId:'subscription-session',turn:{id:'turn-1',status:'completed',items:[{id:'answer',type:'agentMessage',phase:'final_answer',text}]}}});
  }
 } catch(error) { console.error(error); process.exit(2); }
});
`, { mode: 0o700 });
  const config = loadConfig({ MATRIX_HOMESERVER: 'https://matrix.test', MATRIX_OWNER_ID: '@alice:test', RIFTJACK_WORKSPACE: root, CODEX_PATH: cli, CLAUDE_PATH: cli });
  const state = new State(join(root, 'sessions.json')), backend = createBackend(config, state);
  let queue = new BackgroundTasks(join(root, 'watches.json'), root);
  let draft = false;
  const read = async () => ({ head: { sha: 'a'.repeat(40) }, state: 'open', draft, base: { ref: 'main' } });
  const policy = { ghConfigDir: root, repositories: ['example/project'] };
  const file = join(root, 'subscriptions.json');
  let subscriptions = new GitHubSubscriptions(file, policy, queue, read);
  const room = '!room:test';
  const event: MatrixEvent = { type: 'm.room.message', sender: '@alice:test', event_id: '$request', origin_server_ts: Date.now(), content: { msgtype: 'm.text', body: 'Watch the PR.', 'm.relates_to': { rel_type: 'm.thread', event_id: '$thread' } } };
  const key = sessionKey(room, event), replies: string[] = [];
  const bridge = new Bridge({ botId: '@bot:test', kind, since: 0, timeoutMs: 10_000, state,
    isAuthorized: () => true, isPrivateRoom: async () => true, run: backend,
    reply: async (_room, _event, text) => { replies.push(text); }, report: () => {},
    github: async (request, context, signal) => subscriptions.action(request,
      { room: context.room, sender: context.event.sender!, key: context.key, thread: '$thread', session: state.session(context.key)[kind]! }, signal),
  });
  await bridge.handle(room, event);
  assert.equal(replies.at(-1), 'Subscription registered.');
  queue = new BackgroundTasks(join(root, 'watches.json'), root);
  draft = true;
  subscriptions = new GitHubSubscriptions(file, policy, queue, read);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.timers.tick(61_000);
  await subscriptions.pump(() => true, new AbortController().signal);
  await queue.pump({ valid: target => state.session(target.key)[kind] === target.session,
    deliver: (target, message, admitted, ready, completed) => bridge.resumeBackground(target.room, message, target.session, admitted, ready, completed),
    report: error => { throw error; },
  });
  assert.equal(replies.at(-1), 'Observed the saved result.');
  assert.equal(state.session(key)[kind], 'subscription-session');
});
