import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRoomMessageMcp } from '../../src/room-message-mcp.js';
import { roomMessageDelivery } from '../../src/room-messages.js';
import { Bridge } from '../../src/bridge.js';
import { createBackend } from '../../src/backends.js';
import { loadConfig } from '../../src/config.js';
import { State } from '../../src/state.js';
import type { ToolConnection } from '../../src/tool-mcp.js';

const request = { action: 'send', room: '!shared:test', text: 'Ready.', id: 'ready' };
function post(server: ToolConnection, id: number, args: unknown = request, method = 'tools/call') {
  return fetch(server.url, { method: 'POST', headers: { ...server.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { name: 'room_messages', arguments: args } }) });
}

test('room MCP authenticates, reports uncertain sends and does not replay them', async t => {
  let calls = 0;
  const server = await startRoomMessageMcp(roomMessageDelivery(async () => { calls++; throw new Error('private transport details'); }), new AbortController().signal);
  t.after(() => server.close());
  assert.equal((await post({ ...server, headers: { Authorization: 'wrong' } }, 1)).status, 401);
  assert.equal((await (await post(server, 2, {}, 'tools/list')).json()).result.tools[0].name, 'room_messages');
  for (const id of [3, 4]) {
    const result = (await (await post(server, id)).json()).result;
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /uncertain/);
    assert.ok(!result.content[0].text.includes('private transport details'));
  }
  assert.equal(calls, 1);
  assert.ok((await (await post(server, 4)).json()).error);
  await server.close();
  await assert.rejects(post(server, 5));
});

test('room MCP advertises mention and passes it through validated', async t => {
  const requests: unknown[] = [];
  const server = await startRoomMessageMcp(roomMessageDelivery(async request => { requests.push(request); return '{"status":"sent"}'; }), new AbortController().signal);
  t.after(() => server.close());
  const tools = (await (await post(server, 1, {}, 'tools/list')).json()).result.tools;
  assert.equal(tools[0].inputSchema.properties.mention.type, 'boolean');
  assert.ok(tools[0].inputSchema.properties.action.enum.includes('receive_attachment'));
  assert.ok(tools[0].inputSchema.properties.action.enum.includes('send_files'));
  assert.equal((await (await post(server, 2, { ...request, mention: true })).json()).result.isError, undefined);
  // A mentioning text must fit whole into the notice that quotes it.
  const long = (await (await post(server, 3, { ...request, id: 'long', text: 'x'.repeat(7000), mention: true })).json()).result;
  assert.equal(long.isError, true);
  assert.deepEqual(requests, [{ ...request, mention: true }]);
});

test('room MCP passes attachment retrieval and outbox file sends through validation', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'room-files-mcp-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const requests: unknown[] = [];
  const action = roomMessageDelivery(async request => { requests.push(request); return '{}'; });
  const server = await startRoomMessageMcp((input, signal) => action(input, signal, root), new AbortController().signal);
  t.after(() => server.close());
  const receive = { action: 'receive_attachment', room: '!shared:test', event_id: '$image' };
  const files = { action: 'send_files', room: '!shared:test', id: 'files', files: [{ path: 'sample.txt' }] };
  assert.equal((await (await post(server, 1, receive)).json()).result.isError, undefined);
  for (const id of [2, 3]) assert.equal((await (await post(server, id, files)).json()).result.isError, undefined);
  assert.equal((await (await post(server, 4, { ...files, id: 'bad', files: [{ path: '../secret' }] })).json()).result.isError, true);
  assert.deepEqual(requests, [receive, { ...files, outbox: root }]);
});

for (const kind of ['codex', 'claude'] as const) test(`${kind} sends room messages before replying and closes the tool on resumed turns`, { timeout: 25_000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'room-mcp-'))), cli = join(root, 'cli.cjs');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(cli, `#!/usr/bin/env node
const fs=require('node:fs'),args=process.argv.slice(2),send=v=>console.log(JSON.stringify(v));
if(args.includes('--help')) {console.log('--input-format --output-format --permission-mode --permission-prompt-tool --append-system-prompt --tools --settings --resume');process.exit();}
if(args[0]==='auth') {send({loggedIn:true,authMethod:'claude.ai'});process.exit();}
let connection,instructions;
async function work(){
 fs.appendFileSync(__filename+'.connections',JSON.stringify(connection)+'\\n');
 if(!instructions.includes('room_messages')) throw Error('Missing instructions');
 async function call(id,arguments){
  const r=await fetch(connection.url,{method:'POST',headers:{...connection.headers,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name:'room_messages',arguments}})});
  const value=(await r.json()).result;
  if(value.isError) throw Error(value.content[0].text);
  return JSON.parse(value.content[0].text);
 }
 const listed=(await call(1,{action:'list'})).rooms;
 if(listed[0].room!=='!shared:test'||listed[0].type!=='shared'||listed[1].type!=='private') throw Error('Missing room');
 for(const id of [2,3]) if((await call(id,${JSON.stringify(request)})).event_id!=='$sent') throw Error('Missing receipt');
 const received=await call(4,{action:'receive_attachment',room:'!shared:test',event_id:'$file'});
 if(fs.readFileSync(received.file.path,'utf8')!=='Shared file') throw Error('Missing received file');
 const outbox=JSON.parse(instructions.match(/outbox: ("[^"\\n]+")/)[1]);
 fs.copyFileSync(received.file.path,outbox+'/sample.txt');
 for(const id of [5,6]) if((await call(id,{action:'send_files',room:'!shared:test',id:'file',files:[{path:'sample.txt'}]})).files[0].status!=='sent') throw Error('Missing file receipt');
 fs.writeFileSync(__filename+'.completed','yes');
 return 'Delivered.';
}
require('node:readline').createInterface({input:process.stdin}).on('line',async line=>{
 try {
 const message=JSON.parse(line);
 if(args.includes('--print')){
  connection=JSON.parse(args[args.indexOf('--mcp-config')+1]).mcpServers.riftjack_rooms;
  if(!args[args.indexOf('--allowedTools')+1].split(',').includes('mcp__riftjack_rooms__room_messages')) throw Error('Tool policy');
  instructions=args[args.indexOf('--append-system-prompt')+1];
  send({type:'system',subtype:'init',session_id:'same-session'});
  send({type:'result',subtype:'success',result:await work(),session_id:'same-session'});return;
 }
 const {id,method,params:p}=message,reply=result=>send({id,result});
 if(method==='initialize') reply({});
 if(method==='account/read') reply({account:{type:'chatgpt'}});
 if(method==='thread/start'||method==='thread/resume'){
  const c=p.config['mcp_servers.riftjack_rooms'];
  if(!c.required||c.enabled_tools.join()!=='room_messages'||c.tools.room_messages.approval_mode!=='approve') throw Error('Tool policy');
  connection={url:c.url,headers:c.http_headers};
  if(p.developerInstructions!==undefined){instructions=p.developerInstructions;fs.writeFileSync(__filename+'.instructions',instructions);}
  else instructions=fs.readFileSync(__filename+'.instructions','utf8');
  reply({thread:{id:'same-session'}});
 }
 if(method==='thread/inject_items') reply({});
 if(method==='turn/start'){
  reply({turn:{id:'turn',status:'inProgress'}});
  send({method:'turn/started',params:{threadId:'same-session',turn:{id:'turn',status:'inProgress'}}});
  const text=await work();
  send({method:'turn/completed',params:{threadId:'same-session',turn:{id:'turn',status:'completed',items:[{id:'final',type:'agentMessage',phase:'final_answer',text}]}}});
 }
 }catch(e){console.error(e);process.exit(2);}
});
`, { mode: 0o700 });
  const config = loadConfig({ MATRIX_HOMESERVER: 'https://matrix.test', MATRIX_OWNER_ID: '@alice:test', RIFTJACK_WORKSPACE: root, CODEX_PATH: cli, CLAUDE_PATH: cli });
  const state = new State(join(root, 'state.json')), backend = createBackend(config, state);
  const incoming = join(root, 'shared.txt'); writeFileSync(incoming, 'Shared file');
  const order: string[] = [];
  const bridge = new Bridge({ botId: '@bot:test', kind, since: 0, timeoutMs: 15_000, state,
    isAuthorized: () => true, isPrivateRoom: async () => true, run: backend,
    report: () => {}, reply: async (room, _event, text) => { assert.equal(room, '!home:test'); order.push(text); },
    roomMessages: async (request, context) => {
      assert.equal(context.room, '!home:test');
      if (request.action === 'list') return JSON.stringify({ rooms: [{ room: '!shared:test', type: 'shared' }, { room: '!home:test', type: 'private' }] });
      if (request.action === 'receive_attachment') {
        assert.equal(request.event_id, '$file');
        return JSON.stringify({ status: 'received', file: { path: incoming, name: 'shared.txt', image: false } });
      }
      if (request.action === 'send_files') {
        assert.equal(readFileSync(join(request.outbox, request.files[0].path), 'utf8'), 'Shared file');
        assert.ok(request.outbox.startsWith(join(root, '.matrix-media', 'outgoing')));
        order.push('File sent');
        return JSON.stringify({ room: request.room, files: [{ path: request.files[0].path, status: 'sent' }] });
      }
      if (request.action !== 'send') throw new Error('Unexpected room action');
      assert.equal(request.room, '!shared:test');
      assert.throws(() => readFileSync(cli + '.completed'));
      order.push(request.text);
      return JSON.stringify({ status: 'sent', event_id: '$sent' });
    },
  });
  t.after(() => bridge.stop());
  for (let n = 0; n < 2; n++) {
    rmSync(cli + '.completed', { force: true }); order.length = 0;
    await bridge.handle('!home:test', { type: 'm.room.message', event_id: '$' + n, sender: '@alice:test', origin_server_ts: Date.now(),
      content: { msgtype: 'm.text', body: 'Share the result.' } });
    assert.deepEqual(order, ['Ready.', 'File sent', 'Delivered.']);
  }
  const connections = readFileSync(cli + '.connections', 'utf8').trim().split('\n').map(s => JSON.parse(s));
  assert.equal(connections.length, 2);
  assert.notEqual(connections[0].headers.Authorization, connections[1].headers.Authorization);
  for (const connection of connections) await assert.rejects(post(connection, 10));
});
