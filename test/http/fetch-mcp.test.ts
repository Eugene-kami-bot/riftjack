import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFetchMcp } from '../../src/fetch-mcp.js';
import { fetchAction, loadFetchConfig, type Transport } from '../../src/fetch.js';
import { createBackend } from '../../src/backends.js';
import { loadConfig } from '../../src/config.js';
import { State } from '../../src/state.js';
import type { ToolConnection } from '../../src/tool-mcp.js';

const API = 'https://api.github.com/repos/ydb-platform/ydb/';
function post(server: ToolConnection, id: number, args: unknown, method = 'tools/call') {
  return fetch(server.url, { method: 'POST', headers: { ...server.headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { name: 'fetch', arguments: args } }) });
}

test('fetch MCP authenticates, saves allowed responses, refuses others and stops on close', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fetch-mcp-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = loadFetchConfig({ FETCH_ALLOW: API })!;
  let calls = 0;
  const transport: Transport = async () => {
    calls++;
    return { status: 200, contentType: 'application/json', body: Object.assign((async function* () { yield Buffer.from('{"state":"open"}'); })(), { destroy() {} }) };
  };
  const server = await startFetchMcp(fetchAction(config, dir, transport), new AbortController().signal);
  t.after(() => server.close());
  assert.equal((await post({ ...server, headers: { Authorization: 'wrong' } }, 1, {})).status, 401);
  const tool = (await (await post(server, 2, {}, 'tools/list')).json()).result.tools[0];
  assert.equal(tool.name, 'fetch');
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.deepEqual(tool.inputSchema.properties.method.enum, ['GET', 'HEAD']);
  const saved = (await (await post(server, 3, { url: `${API}pulls/1` })).json()).result;
  assert.equal(saved.isError, undefined);
  const result = JSON.parse(saved.content[0].text);
  assert.ok(result.file.startsWith(join(dir, '.fetch') + '/'));
  assert.equal(readFileSync(result.file, 'utf8'), '{"state":"open"}');
  const refused = (await (await post(server, 4, { url: 'https://evil.test/' })).json()).result;
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /not allowed/);
  assert.equal(calls, 1);
  await server.close();
  await assert.rejects(post(server, 5, { url: `${API}pulls/1` }));
});

// The fake CLI records what each backend passed for the fetch server and checks that the
// server answers during the turn; the test then checks it is closed after the turn.
const cliSource = `#!/usr/bin/env node
const fs=require('node:fs'),args=process.argv.slice(2),send=v=>console.log(JSON.stringify(v));
if(args.includes('--help')) {console.log('--input-format --output-format --permission-mode --permission-prompt-tool --append-system-prompt --tools --settings --resume');process.exit();}
if(args[0]==='auth') {send({loggedIn:true,authMethod:'claude.ai'});process.exit();}
const record=v=>fs.appendFileSync(__filename+'.seen',JSON.stringify(v)+'\\n');
async function listed(c){
 if(!c) return null;
 const r=await fetch(c.url,{method:'POST',headers:{...c.headers,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}})});
 return (await r.json()).result.tools.map(t=>t.name);
}
require('node:readline').createInterface({input:process.stdin}).on('line',async line=>{
 try {
 const message=JSON.parse(line);
 if(args.includes('--print')){
  const servers=args.includes('--mcp-config')?JSON.parse(args[args.indexOf('--mcp-config')+1]).mcpServers:{};
  const c=servers.riftjack_fetch,allowed=args.includes('--allowedTools')?args[args.indexOf('--allowedTools')+1].split(','):[];
  const instructions=args[args.indexOf('--append-system-prompt')+1]||'';
  const addDir=args.includes('--add-dir')?args[args.indexOf('--add-dir')+1]:null;
  record({connection:c?{url:c.url,headers:c.headers}:null,allowed:allowed.includes('mcp__riftjack_fetch__fetch'),addDir,instructions:instructions.includes('fetch MCP tool'),tools:await listed(c)});
  send({type:'system',subtype:'init',session_id:'s'});
  send({type:'result',subtype:'success',result:'done',session_id:'s'});return;
 }
 const {id,method,params:p}=message,reply=result=>send({id,result});
 if(method==='initialize') reply({});
 if(method==='account/read') reply({account:{type:'chatgpt'}});
 if(method==='thread/start'||method==='thread/resume'){
  const saved=__filename+'.instructions-'+(p.threadId||'s');
  if(p.developerInstructions!==undefined) fs.writeFileSync(saved,p.developerInstructions);
  const instructions=fs.existsSync(saved)?fs.readFileSync(saved,'utf8'):'';
  const c=p.config['mcp_servers.riftjack_fetch'];
  const on=c&&c.enabled!==false;
  record({connection:on?{url:c.url,headers:c.http_headers}:null,enabled:!!on,policy:on?[c.required,c.enabled_tools.join(),c.tools.fetch.approval_mode].join():null,
   instructions:instructions.includes('fetch MCP tool'),tools:on?await listed({url:c.url,headers:c.http_headers}):null});
  reply({thread:{id:'s'}});
 }
 if(method==='thread/inject_items') reply({});
 if(method==='turn/start'){
  reply({turn:{id:'turn',status:'inProgress'}});
  send({method:'turn/started',params:{threadId:'s',turn:{id:'turn',status:'inProgress'}}});
  send({method:'turn/completed',params:{threadId:'s',turn:{id:'turn',status:'completed',items:[{id:'final',type:'agentMessage',phase:'final_answer',text:'done'}]}}});
 }
 }catch(e){console.error(e);process.exit(2);}
});
`;

for (const kind of ['codex', 'claude'] as const) test(`${kind} offers fetch only when configured and not read-only, and closes it after the turn`, { timeout: 30_000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'fetch-backend-'))), cli = join(root, 'cli.cjs');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(cli, cliSource, { mode: 0o700 });
  const base = { MATRIX_HOMESERVER: 'https://matrix.test', MATRIX_OWNER_ID: '@alice:test', RIFTJACK_WORKSPACE: root, CODEX_PATH: cli, CLAUDE_PATH: cli };
  const turn = async (env: Record<string, string>, key: string) => {
    const config = loadConfig({ ...base, ...env });
    const backend = createBackend(config, new State(join(root, key + '.json')));
    await backend(kind, 'Check CI.', key, new AbortController().signal, '@alice:test');
  };
  await turn({ FETCH_ALLOW: API }, 'on');
  await turn({ FETCH_ALLOW: API }, 'on'); // resumed session gets a new server
  await turn({}, 'off');
  await turn({ FETCH_ALLOW: API, CODEX_SANDBOX: 'read-only' }, 'readonly');
  const seen = readFileSync(cli + '.seen', 'utf8').trim().split('\n').map(s => JSON.parse(s));
  assert.equal(seen.length, 4);
  for (const on of seen.slice(0, 2)) {
    assert.deepEqual(on.tools, ['fetch']);
    assert.equal(on.instructions, true);
    if (kind === 'claude') { assert.equal(on.allowed, true); assert.equal(on.addDir, null); }
    else assert.equal(on.policy, 'true,fetch,approve');
  }
  assert.notEqual(seen[0].connection.headers.Authorization, seen[1].connection.headers.Authorization);
  for (const off of seen.slice(2)) {
    assert.equal(off.connection, null);
    assert.equal(off.instructions, false);
  }
  for (const on of seen.slice(0, 2)) await assert.rejects(post(on.connection, 9, { url: `${API}pulls/1` }));
});
