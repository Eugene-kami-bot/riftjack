import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBackgroundMcp } from '../../src/background-mcp.js';
import { BackgroundTasks } from '../../src/background-tasks.js';
import { Bridge, sessionKey, type MatrixEvent } from '../../src/bridge.js';
import { createBackend } from '../../src/backends.js';
import { loadConfig } from '../../src/config.js';
import { State } from '../../src/state.js';

const input = { action: 'watch', label: 'Example build', status_file: 'status.json', field: 'stage', terminal: ['complete', 'failed'], pid: process.pid, stale_after_minutes: 5 };
test('background MCP has scoped authentication and closes at the end of the task', async t => {
  const lifetime = new AbortController();
  let called = 0;
  const server = await startBackgroundMcp(async () => { called++; return 'registered'; }, lifetime.signal);
  t.after(() => server.close());
  const post = (auth: string, id: number) => fetch(server.url, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'background_tasks', arguments: input } }) });
  assert.equal((await post('Bearer wrong', 1)).status, 401);
  assert.equal((await (await post(server.headers.Authorization, 2)).json()).result.content[0].text, 'registered');
  assert.ok((await (await post(server.headers.Authorization, 2)).json()).error);
  assert.equal(called, 1);
  lifetime.abort(); await server.close();
  await assert.rejects(post(server.headers.Authorization, 3));
});

test('background MCP advertises and schedules delayed messages', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'background-mcp-timer-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const queue = new BackgroundTasks(join(root, 'watches.json'), root);
  const target = { room: '!room:test', sender: '@alice:test', key: 'key', session: 'session' };
  const lifetime = new AbortController();
  const server = await startBackgroundMcp(async (request, signal) => queue.action(request, target, signal), lifetime.signal);
  t.after(() => server.close());
  const call = async (id: number, method: string, params?: object) => (await (await fetch(server.url, { method: 'POST',
    headers: { ...server.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })).json());
  const tools = await call(1, 'tools/list');
  assert.ok(tools.result.tools[0].inputSchema.properties.action.enum.includes('remind'));
  assert.equal(tools.result.tools[0].inputSchema.properties.pid.minimum, 1);
  assert.equal(tools.result.tools[0].inputSchema.properties.stale_after_minutes.maximum, 10080);
  const scheduled = JSON.parse((await call(2, 'tools/call', { name: 'background_tasks',
    arguments: { action: 'remind', label: 'Later', message: 'Check the build.', deliver: 'room', delay_minutes: 30 } })).result.content[0].text);
  assert.deepEqual([scheduled.room, scheduled.message, scheduled.state], ['!room:test', 'Check the build.', 'waiting']);
  const listed = JSON.parse((await call(3, 'tools/call', { name: 'background_tasks', arguments: { action: 'list' } })).result.content[0].text);
  assert.deepEqual(listed.map((w: { id: string; kind: string }) => [w.id, w.kind]), [[scheduled.id, 'timer']]);
  const schedule = { frequency: 'daily', time: '09:00', timezone: 'UTC' };
  const recurring = JSON.parse((await call(4, 'tools/call', { name: 'background_tasks',
    arguments: { action: 'remind', label: 'Daily', message: 'Check project updates.', deliver: 'room', schedule } })).result.content[0].text);
  assert.deepEqual(recurring.schedule, schedule);
  const posts: string[] = [];
  await queue.pump({ valid: () => true, report: error => { throw error; }, deliver: async () => false,
    post: async (_t, message, admit) => { admit(); posts.push(message); return true; } }, Date.parse(recurring.due));
  const after = JSON.parse((await call(5, 'tools/call', { name: 'background_tasks', arguments: { action: 'list' } })).result.content[0].text);
  const saved = after.find((w: { id: string }) => w.id === recurring.id);
  assert.equal(saved.state, 'waiting'); assert.equal(saved.lastRun.state, 'delivered');
  assert.ok(Date.parse(saved.due) > Date.parse(recurring.due));
  assert.ok(posts.includes('Check project updates.'));
  const cancelled = JSON.parse((await call(6, 'tools/call', { name: 'background_tasks', arguments: { action: 'cancel', id: recurring.id } })).result.content[0].text);
  assert.equal(cancelled.state, 'cancelled');
});

for (const kind of ['codex', 'claude'] as const) test(`${kind} registers through MCP and resumes the same session after completion`, { timeout: 20_000 }, async t => {
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
  if (prompt.includes('background task watch registered')) {
    if (!resumed) throw Error('Lost session');
    return 'Observed the saved result.';
  }
  const response=await fetch(connection.url,{method:'POST',headers:{...connection.headers,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:7,method:'tools/call',params:{name:'background_tasks',arguments:${JSON.stringify(input)}}})});
  const message=await response.json();
  if (message.result.isError) throw Error(message.result.content[0].text);
  return 'Watch registered.';
}
require('node:readline').createInterface({input:process.stdin}).on('line',async line=>{
 try {
  const message=JSON.parse(line);
  if (args.includes('--mcp-config')) {
    connection=JSON.parse(args[args.indexOf('--mcp-config')+1]).mcpServers.riftjack_tasks;
    if (!args[args.indexOf('--allowedTools')+1].includes('mcp__riftjack_tasks__background_tasks')) throw Error('Tool not allowed');
    resumed=args.includes('--resume');
    send({type:'system',subtype:'init',session_id:'background-session'});
    const result=await work(message.message.content[0].text);
    send({type:'result',subtype:'success',result,session_id:'background-session'});
    return;
  }
  const {id,method,params:p}=message;
  const reply=result=>send({id,result});
  if (method==='initialize') reply({});
  if (method==='account/read') reply({account:{type:'chatgpt'}});
  if (method==='thread/start'||method==='thread/resume') {
    resumed=method==='thread/resume';
    const c=p.config['mcp_servers.riftjack_tasks'];
    if (!c.enabled_tools.includes('background_tasks')||c.tools.background_tasks.approval_mode!=='approve') throw Error('Tool policy');
    connection={url:c.url,headers:c.http_headers};
    reply({thread:{id:'background-session'}});
  }
  if (method==='thread/inject_items') reply({});
  if (method==='turn/start') {
    reply({turn:{id:'turn-1',status:'inProgress'}});
    const text=await work(p.input[0].text);
    send({method:'turn/completed',params:{threadId:'background-session',turn:{id:'turn-1',status:'completed',items:[{id:'answer',type:'agentMessage',phase:'final_answer',text}]}}});
  }
 } catch(error) { console.error(error); process.exit(2); }
});
`, { mode: 0o700 });
  writeFileSync(join(root, 'status.json'), '{"stage":"building"}');
  const config = loadConfig({ MATRIX_HOMESERVER: 'https://matrix.test', MATRIX_OWNER_ID: '@alice:test', RIFTJACK_WORKSPACE: root, CODEX_PATH: cli, CLAUDE_PATH: cli });
  const state = new State(join(root, 'sessions.json')), backend = createBackend(config, state);
  let queue = new BackgroundTasks(join(root, 'watches.json'), root);
  const room = '!room:test';
  const event: MatrixEvent = { type: 'm.room.message', sender: '@alice:test', event_id: '$request', origin_server_ts: Date.now(), content: { msgtype: 'm.text', body: 'Watch the build.', 'm.relates_to': { rel_type: 'm.thread', event_id: '$thread' } } };
  const key = sessionKey(room, event), replies: string[] = [];
  const bridge = new Bridge({ botId: '@bot:test', kind, since: 0, timeoutMs: 10_000, state,
    isAuthorized: () => true, isPrivateRoom: async () => true, run: backend,
    reply: async (_room, _event, text) => { replies.push(text); }, report: () => {},
    background: async (request, context, signal) => queue.action(request,
      { room: context.room, sender: context.event.sender!, key: context.key, thread: '$thread', session: state.session(context.key)[kind]! }, signal),
  });
  await bridge.handle(room, event);
  assert.equal(replies.at(-1), 'Watch registered.');
  queue = new BackgroundTasks(join(root, 'watches.json'), root);
  writeFileSync(join(root, 'status.json'), '{"stage":"complete"}');
  await queue.pump({ valid: target => state.session(target.key)[kind] === target.session,
    deliver: (target, message, admitted) => bridge.resumeBackground(target.room, message, target.session, admitted),
    report: error => { throw error; },
  });
  assert.equal(replies.at(-1), 'Observed the saved result.');
  assert.equal(state.session(key)[kind], 'background-session');
});
