import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAttachmentMcp } from '../../src/attachment-mcp.js';
import { attachmentDelivery } from '../../src/attachment-delivery.js';
import { Bridge, type MatrixEvent } from '../../src/bridge.js';
import { createBackend } from '../../src/backends.js';
import { loadConfig } from '../../src/config.js';
import { State } from '../../src/state.js';
import type { ToolConnection } from '../../src/tool-mcp.js';

function fixture(t: { after(fn: () => void): void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'attachment-mcp-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function post(server: ToolConnection, id: number, method = 'tools/call', args: unknown = { files: [{ path: 'ready.txt' }] }) {
  return fetch(server.url, { method: 'POST', headers: { ...server.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { name: 'send_attachments', arguments: args } }) });
}

test('attachment MCP authenticates, pins the destination, deduplicates retries and expires', async t => {
  const root = fixture(t); writeFileSync(join(root, 'ready.txt'), 'ready');
  let calls = 0;
  const controller = new AbortController();
  const delivery = attachmentDelivery(root, 1024, async () => { calls++; });
  const server = await startAttachmentMcp(delivery.action, controller.signal);
  t.after(() => server.close());
  assert.equal((await post({ ...server, headers: { Authorization: 'Bearer wrong' } }, 1)).status, 401);
  const list = await (await post(server, 2, 'tools/list')).json();
  assert.equal(list.result.tools[0].name, 'send_attachments');
  assert.equal((await (await post(server, 3, 'tools/call', { room: '!other:test', files: [{ path: 'ready.txt' }] })).json()).result.isError, true);
  for (const id of [4, 5]) {
    const result = await (await post(server, id)).json();
    assert.equal(JSON.parse(result.result.content[0].text).files[0].status, 'sent');
  }
  assert.equal(calls, 1);
  assert.ok((await (await post(server, 5)).json()).error);
  controller.abort(); await server.close();
  await assert.rejects(post(server, 6));
});

test('closing the MCP aborts a pending attachment transport', async t => {
  const root = fixture(t); writeFileSync(join(root, 'ready.txt'), 'ready');
  let started!: () => void;
  const ready = new Promise<void>(yes => { started = yes; });
  let aborted = false;
  const delivery = attachmentDelivery(root, 1024, async (_files, signal) => {
    started();
    await new Promise<void>((_yes, no) => signal.addEventListener('abort', () => { aborted = true; no(signal.reason); }, { once: true }));
  });
  const server = await startAttachmentMcp(delivery.action, new AbortController().signal);
  t.after(() => server.close());
  const pending = post(server, 1).then(r => r.json()).catch(() => undefined);
  await ready; await server.close(); await pending;
  assert.equal(aborted, true);
});

for (const kind of ['codex', 'claude'] as const) test(`${kind} sends files through MCP before final text and deduplicates the final manifest on resumed turns`, { timeout: 25_000 }, async t => {
  const root = fixture(t), cli = join(root, 'cli.cjs');
  writeFileSync(cli, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),send=v=>console.log(JSON.stringify(v));
if(args.includes('--help')) { console.log('--input-format --output-format --permission-mode --permission-prompt-tool --append-system-prompt --tools --settings --resume'); process.exit(); }
if(args[0]==='auth') {send({loggedIn:true,authMethod:'claude.ai'});process.exit();}
let connection,instructions;
async function work(){
 fs.appendFileSync(__filename+'.connections',JSON.stringify(connection)+'\\n');
 if(!instructions.includes('send_attachments')) throw Error('Missing instructions');
 const root=JSON.parse(instructions.match(/outbox: ("[^\\n]+?")\\. It is/)[1]);
 fs.writeFileSync(path.join(root,'ready.txt'),'ready');
 fs.writeFileSync(path.join(root,'later.txt'),'later');
 const r=await fetch(connection.url,{method:'POST',headers:{...connection.headers,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:7,method:'tools/call',params:{name:'send_attachments',arguments:{files:[{path:'ready.txt'}]}}})});
 const result=await r.json();
 if(result.result.isError||JSON.parse(result.result.content[0].text).files[0].status!=='sent') throw Error('Not sent');
 fs.writeFileSync(__filename+'.completed','yes');
 return 'Done\\n'+String.fromCharCode(96).repeat(3)+'matrix-attachments\\n'+JSON.stringify({files:[{path:'ready.txt'},{path:'later.txt'}]})+'\\n'+String.fromCharCode(96).repeat(3);
}
require('node:readline').createInterface({input:process.stdin}).on('line',async line=>{
 try{
 const message=JSON.parse(line);
 if(args.includes('--print')){
  connection=JSON.parse(args[args.indexOf('--mcp-config')+1]).mcpServers.riftjack_attachments;
  if(!args[args.indexOf('--allowedTools')+1].split(',').includes('mcp__riftjack_attachments__send_attachments')||connection.timeout!==86400000) throw Error('Tool policy');
  instructions=args[args.indexOf('--append-system-prompt')+1];
  send({type:'system',subtype:'init',session_id:'same-session'});
  send({type:'assistant',message:{content:[{type:'text',text:'Sending a ready file.'},{type:'tool_use',id:'tool',name:'send_attachments',input:{}}]}});
  const result=await work();
  send({type:'result',subtype:'success',result,session_id:'same-session'});return;
 }
 const {id,method,params:p}=message,reply=result=>send({id,result});
 if(method==='initialize') reply({});
 if(method==='account/read') reply({account:{type:'chatgpt'}});
 if(method==='thread/start'||method==='thread/resume'){
  const c=p.config['mcp_servers.riftjack_attachments'];
  if(!c.required||c.tool_timeout_sec!==86400||c.enabled_tools.join()!=='send_attachments'||c.tools.send_attachments.approval_mode!=='approve') throw Error('Tool policy');
  connection={url:c.url,headers:c.http_headers};
  if(p.developerInstructions!==undefined){instructions=p.developerInstructions;fs.writeFileSync(__filename+'.instructions',instructions);}
  else instructions=fs.readFileSync(__filename+'.instructions','utf8');
  reply({thread:{id:'same-session'}});
 }
 if(method==='thread/inject_items') reply({});
 if(method==='turn/start'){
  reply({turn:{id:'turn',status:'inProgress'}});
  send({method:'turn/started',params:{threadId:'same-session',turn:{id:'turn',status:'inProgress'}}});
  send({method:'item/completed',params:{threadId:'same-session',turnId:'turn',item:{id:'progress',type:'agentMessage',phase:'commentary',text:'Sending a ready file.'}}});
  const text=await work();
  send({method:'turn/completed',params:{threadId:'same-session',turn:{id:'turn',status:'completed',items:[{id:'final',type:'agentMessage',phase:'final_answer',text}]}}});
 }
 }catch(e){console.error(e);process.exit(2);}
});
`, { mode: 0o700 });
  const config = loadConfig({ MATRIX_HOMESERVER: 'https://matrix.test', MATRIX_OWNER_ID: '@alice:test', RIFTJACK_WORKSPACE: root, CODEX_PATH: cli, CLAUDE_PATH: cli });
  const state = new State(join(root, 'state.json')), backend = createBackend(config, state);
  const order: string[] = [];
  const bridge = new Bridge({ botId: '@bot:test', kind, since: 0, timeoutMs: 15_000, state,
    isAuthorized: () => true, isPrivateRoom: async () => true, run: backend,
    report: () => {}, reply: async (_room, _event, text) => { order.push(text); },
    sendAttachments: async (room, event, files) => {
      assert.equal(room, '!shared:test'); assert.equal(event.content?.['m.relates_to']?.event_id, '$thread');
      for (const file of files) {
        const contents = readFileSync(file.path, 'utf8');
        if (contents === 'ready') assert.throws(() => readFileSync(cli + '.completed'));
        order.push(contents);
      }
    },
  });
  t.after(() => bridge.stop());
  for (let n = 0; n < 2; n++) {
    rmSync(cli + '.completed', { force: true }); order.length = 0;
    const event: MatrixEvent = { type: 'm.room.message', event_id: '$' + n, sender: '@alice:test', origin_server_ts: Date.now(),
      content: { msgtype: 'm.text', body: 'Send a file and continue.', 'm.relates_to': { rel_type: 'm.thread', event_id: '$thread' } } };
    await bridge.handle('!shared:test', event);
    assert.deepEqual(order, ['Sending a ready file.', 'ready', 'Done', 'later']);
  }
  const connections = readFileSync(cli + '.connections', 'utf8').trim().split('\n').map(s => JSON.parse(s));
  assert.equal(connections.length, 2);
  assert.notEqual(connections[0].headers.Authorization, connections[1].headers.Authorization);
  for (const connection of connections) await assert.rejects(post(connection, 10));
});
