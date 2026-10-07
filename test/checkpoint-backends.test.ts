import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackend } from '../src/backends.js';
import { State } from '../src/state.js';
import { loadConfig } from '../src/config.js';

const fake = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2), claude = !args.includes('app-server');
const log = x => fs.appendFileSync(__filename+'.calls', JSON.stringify(x)+'\\n');
const emit = x => console.log(JSON.stringify(x));
if (args.includes('--help')) { console.log('--input-format --output-format --permission-mode --permission-prompt-tool --append-system-prompt --tools --settings --resume --replay-user-messages'); process.exit(0); }
if (args[0]==='auth') { emit({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty'}); process.exit(0); }
const threadId='session', turnId='turn'; let mode, started=false;
const usage = foreign => claude
 ? emit({type:'assistant',session_id:threadId,parent_tool_use_id:foreign?'child':null,message:{model:'model',content:[],usage:{input_tokens:10000,cache_read_input_tokens:120000}}})
 : emit({method:'thread/tokenUsage/updated',params:{threadId:foreign?'other':threadId,turnId,tokenUsage:{last:{totalTokens:130000},total:{totalTokens:999999999},modelContextWindow:200000}}});
const complete = () => claude
 ? emit({type:'result',subtype:'success',session_id:threadId,is_error:false,result:'done',modelUsage:{model:{contextWindow:200000}}})
 : emit({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed',items:[{id:'answer',type:'agentMessage',text:'done'}]}}});
const compact = () => {
 if (claude) { emit({type:'system',subtype:'status',status:'compacting',session_id:threadId});emit({type:'system',subtype:'compact_boundary',session_id:threadId}); }
 else { const item={id:'compact',type:'contextCompaction'};for(const method of ['item/started','item/started','item/completed','item/completed'])emit({method,params:{threadId,turnId,item}}); }
};
const update = text => {
 log({notice:text});
 if (text.includes('reported context usage')) {
  usage(false); // repeating high usage must not enqueue another save
  if (mode.includes('cycle')) {compact();return;}
 }
 complete();
};
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); log(m);
 if (claude) {
  if (started) { emit({type:'user',isReplay:true,uuid:m.uuid,session_id:threadId,message:m.message});update(m.message.content[0].text);return; }
  started=true;mode=m.message.content[0].text;emit({type:'system',subtype:'init',session_id:threadId,model:'model'});
 } else {
  const p=m.params;
  if(m.method==='initialize')return emit({id:m.id,result:{}});
  if(m.method==='initialized')return;
  if(m.method==='account/read')return emit({id:m.id,result:{account:{type:'chatgpt'}}});
  if(m.method==='thread/start'||m.method==='thread/resume')return emit({id:m.id,result:{thread:{id:threadId}}});
  if(m.method==='thread/inject_items')return emit({id:m.id,result:{}});
  if(m.method==='turn/steer') {emit({id:m.id,result:{turnId}});update(p.input[0].text);return;}
  if(m.method!=='turn/start')return;
  mode=p.input[0].text;emit({method:'turn/started',params:{threadId,turn:{id:turnId}}});emit({id:m.id,result:{turn:{id:turnId,status:'inProgress'}}});
 }
 if(mode.startsWith('cycle')||mode.startsWith('high')) {usage(true);usage(false);return;}
 if(mode.startsWith('late')) {compact();complete();return;}
 complete();
});
`;

for (const kind of ['codex', 'claude'] as const) {
  const setup = (t: { after(fn: () => void): void }) => {
    const dir = mkdtempSync(join(tmpdir(), 'checkpoint-backend-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const executable = join(dir, 'fake.cjs'); writeFileSync(executable, fake, { mode: 0o700 });
    const state = new State(join(dir, 'state.json'));
    if (kind === 'claude') state.update('key', { claude:'session', claudeCheckpoint:{session:'session',generation:0,warned:false,claudeModel:'model',claudeWindow:200000} });
    const config = loadConfig({ MATRIX_HOMESERVER:'https://matrix.test', MATRIX_USER_ID:'@bot:test', MATRIX_ACCESS_TOKEN:'test', MATRIX_OWNER_ID:'@owner:test', MATRIX_DEVICE_ID:'test', RIFTJACK_WORKSPACE:dir, DATA_DIR:join(dir,'data'), CODEX_PATH:executable, CLAUDE_PATH:executable });
    const backend = createBackend(config, state);
    return { dir, state, backend, recreate: () => createBackend(config, new State(join(dir, 'state.json'))), reload: () => new State(join(dir, 'state.json')),
      calls: () => readFileSync(executable+'.calls','utf8').trim().split('\n').map(l=>JSON.parse(l)) };
  };

  test(`${kind}: high usage sends one save, compaction sends one restore in the running turn`, async t => {
    const f=setup(t);
    await f.backend(kind, 'cycle', 'key', AbortSignal.timeout(5000), '@owner:test');
    const notes=f.calls().filter(c=>c.notice).map(c=>c.notice);
    assert.equal(notes.length,2);assert.match(notes[0],/reported context usage/);assert.match(notes[1],/compaction completed/);
    assert.equal(f.state.session('key')[kind==='codex'?'codexCheckpoint':'claudeCheckpoint']?.pending,undefined);
    assert.equal(existsSync(join(f.dir,'.riftjack','checkpoints')),false); // connector never writes the agent's note
  });

  test(`${kind}: compaction at turn end is restored on next input, once, after backend recreation`, async t => {
    const f=setup(t);
    await f.backend(kind,'late','key',AbortSignal.timeout(5000),'@owner:test');
    // Depending on the CLI event timing, a live update may already be consumed.
    const field=kind==='codex'?'codexCheckpoint':'claudeCheckpoint';
    const pending=f.state.session('key')[field]?.pending;
    const resumed = f.recreate();
    await resumed(kind,'continue','key',AbortSignal.timeout(5000),'@owner:test');
    const inputs=f.calls().filter(c=>kind==='codex'?c.method==='turn/start':c.type==='user'&&!c.uuid);
    const text=kind==='codex'?inputs[1].params.input[0].text:inputs[1].message.content[0].text;
    if(pending==='restore') assert.match(text,/compaction completed/);
    assert.equal(f.reload().session('key')[field]?.pending,undefined);
    await resumed(kind,'again','key',AbortSignal.timeout(5000),'@owner:test');
    const last=f.calls().filter(c=>kind==='codex'?c.method==='turn/start':c.type==='user'&&!c.uuid).at(-1);
    assert.equal(kind==='codex'?last.params.input[0].text:last.message.content[0].text,'again');
  });
}
