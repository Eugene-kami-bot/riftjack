import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { crc32, deflateSync, deflateRawSync } from 'node:zlib';
import { diagramSource, MAX_XML } from '../src/drawio-source.js';
import { embedDiagram, extractDiagram } from '../src/drawio-png.js';
import { drawioAction, loadDrawioConfig, renderDrawio, type Renderer } from '../src/drawio.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==', 'base64');
const xml = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="Привет &amp; 世界" vertex="1" parent="1" style="rounded=1;html=1;"><mxGeometry x="20" y="20" width="120" height="60" as="geometry"/></mxCell></root></mxGraphModel>';
const config = { executable: '/opt/drawio' };
const signal = () => new AbortController().signal;
async function fixture(t: TestContext) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'drawio-')));
  t.after(() => rm(dir, { recursive: true, force: true })); return dir;
}
const render: Renderer = async (_exe, dir) => { await writeFile(join(dir, 'render.png'), png); };

test('diagram accepts plain, formatted and compressed pages and requires explicit multi-page selection', () => {
  assert.equal(diagramSource(xml).pages, 1);
  const plain = xml.replace('Привет &amp; 世界', 'A &amp; B').replace('html=1;', 'html=0;');
  assert.match(diagramSource(plain).renderXml, /value="A &amp; B"/);
  const formatted = xml.replace('Привет &amp; 世界', '&lt;b&gt;Hello&lt;/b&gt;');
  assert.match(diagramSource(formatted).renderXml, /&lt;b&gt;Hello/);
  const compressed = deflateRawSync(Buffer.from(encodeURIComponent(xml))).toString('base64');
  const multi = `<mxfile><diagram id="a">${xml}</diagram><diagram id="b">${compressed}</diagram></mxfile>`;
  assert.throws(() => diagramSource(multi), /Choose page/);
  assert.equal(diagramSource(multi, 2).renderXml, diagramSource(xml).renderXml);
  for (const page of [0, 3, 1.5, NaN]) assert.throws(() => diagramSource(multi, page), /Page/);
});
test('diagram rejects resources and active content before launching a renderer', () => {
  for (const bad of [
    '<!DOCTYPE x [<!ENTITY x SYSTEM "file:///secret">]>' + xml,
    xml.replace('rounded=1;', 'image=https://evil.test/a;'),
    xml.replace('rounded=1;', 'shape=stencil(evil);'),
    xml.replace('Привет &amp; 世界', '&lt;img src="x"/&gt;'),
    xml.replace('Привет &amp; 世界', '&lt;script&gt;alert(1)&lt;/script&gt;'),
    xml.replace('Привет &amp; 世界', '&lt;span style=&quot;background-image:url(file:///secret)&quot;&gt;x&lt;/span&gt;'),
    xml.replace('<root>', '<root><include name="/secret"/>'),
    xml.replace('width="120"', 'width="1e100"'),
    xml.replace('as="geometry"', 'as="__proto__"'),
    xml.replace('id="2"', 'id="__proto__"'),
    xml.replace('vertex="1"', 'vertex="1" onload="evil"'),
    '<mxfile><diagram>' + deflateRawSync(Buffer.from('x'.repeat(MAX_XML * 4))).toString('base64') + '</diagram></mxfile>',
    'x'.repeat(MAX_XML + 1),
  ]) assert.throws(() => diagramSource(bad));
});
test('PNG source round-trips Unicode and compressed documents and rejects corruption', () => {
  for (const source of [xml, '<mxfile><diagram>' + deflateRawSync(Buffer.from(encodeURIComponent(xml))).toString('base64') + '</diagram></mxfile>']) {
    const editable = embedDiagram(png, source);
    assert.equal(extractDiagram(editable), source);
    assert.equal(extractDiagram(embedDiagram(editable, xml)), xml);
    assert.throws(() => extractDiagram(editable.subarray(0, -1)), /Truncated|Invalid/);
    const corrupt = Buffer.from(editable); corrupt[40] ^= 1;
    assert.throws(() => extractDiagram(corrupt), /checksum/);
  }
  assert.throws(() => extractDiagram(png), /embedded/);
});
test('render and extract create new outbox files with exact original source; nothing is sent', async t => {
  const dir = await fixture(t), action = drawioAction(config, dir, 1024 * 1024, render);
  const output = JSON.parse(await action({ action: 'render', xml }, signal()));
  assert.equal(output.editable, true); assert.equal(output.page, 1);
  const saved = await readFile(output.file); assert.equal(extractDiagram(saved), xml);
  const extracted = JSON.parse(await action({ action: 'extract', path: output.path }, signal()));
  assert.equal(await readFile(extracted.file, 'utf8'), xml); assert.equal(extracted.untrusted, true);
  assert.notEqual(extracted.path, output.path);
  assert.deepEqual((await readdir(dir)).sort(), [output.path, extracted.path].sort());
});
test('extract refuses paths outside the outbox, links and oversize output; invalid requests never render', async t => {
  const dir = await fixture(t); let calls = 0;
  const action = drawioAction(config, dir, 1024 * 1024, async (...args) => { calls++; await render(...args); });
  for (const req of [{ action: 'render', xml, page: '1' }, { action: 'render', xml, output: '/x' }, { action: 'extract', path: '../x' }, { action: 'extract', path: '/x' }]) await assert.rejects(action(req, signal()));
  await symlink('/etc/hosts', join(dir, 'link.png'));
  await assert.rejects(action({ action: 'extract', path: 'link.png' }, signal()), /symlink/);
  assert.equal(calls, 0);
  await assert.rejects(drawioAction(config, dir, 1, render)({ action: 'render', xml }, signal()), /attachment size/);
  assert.deepEqual(await readdir(dir), ['link.png']);
});
test('one render across conversations; cancellation cleans job and releases capacity', async t => {
  const dir = await fixture(t), controller = new AbortController(); let entered!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const waiting: Renderer = async (_exe, _dir, sig) => new Promise((_resolve, reject) => {
    sig.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); entered();
  });
  const first = drawioAction(config, dir, MAX_XML, waiting)({ action: 'render', xml }, controller.signal);
  await started;
  await assert.rejects(drawioAction(config, dir, MAX_XML, render)({ action: 'render', xml }, signal()), /Another diagram/);
  controller.abort(); await assert.rejects(first, /cancelled/);
  assert.deepEqual(await readdir(dir), []);
  await drawioAction(config, dir, MAX_XML, render)({ action: 'render', xml }, signal());
});
test('renderer uses a dedicated profile, fixed arguments and a minimal environment', async t => {
  const dir = await fixture(t), executable = join(dir, 'renderer.cjs');
  await writeFile(executable, `#!${process.execPath}\nrequire('fs').writeFileSync('seen.json',JSON.stringify({args:process.argv.slice(2),env:process.env}));require('fs').writeFileSync('render.svg','<svg width="120px" height="60px"/>');`, { mode: 0o700 });
  await renderDrawio(executable, dir, signal());
  const seen = JSON.parse(await readFile(join(dir, 'seen.json'), 'utf8'));
  assert.ok(seen.args.includes('--export')); assert.ok(seen.args.includes('--proxy-server=http://127.0.0.1:9'));
  assert.ok(seen.args.includes('--user-data-dir=' + join(dir, 'home', 'profile')));
  assert.equal(seen.env.HOME, process.env.HOME);
  assert.ok(Object.keys(seen.env).every(k => ['HOME','XDG_CONFIG_HOME','XDG_CACHE_HOME','PATH','LANG','LC_ALL','TMPDIR','DISPLAY','XAUTHORITY','__CF_USER_TEXT_ENCODING'].includes(k)), JSON.stringify(Object.keys(seen.env)));
});
test('drawio is disabled by default and executable must be owner-controlled outside workspace', async t => {
  const dir = await fixture(t);
  assert.equal(loadDrawioConfig({}, dir), undefined);
  assert.throws(() => loadDrawioConfig({ DRAWIO_PATH: 'drawio' }, dir), /absolute/);
  const exe = join(dir, 'drawio'); await writeFile(exe, '#!/bin/sh\n', { mode: 0o700 });
  assert.throws(() => loadDrawioConfig({ DRAWIO_PATH: exe }, dir), /outside/);
  assert.equal(loadDrawioConfig({ DRAWIO_PATH: exe }, join(dir, 'workspace'))?.executable, exe);
});

test('native renderer cancellation kills its own child group and settles before cleanup', async t => {
  const dir = await fixture(t), exe = join(dir, 'slow.cjs');
  await writeFile(exe, `#!${process.execPath}\nconst c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); require('fs').writeFileSync('child.json',JSON.stringify({parent:process.pid,child:c.pid})); process.on('SIGTERM',()=>c.once('exit',()=>process.exit())); setInterval(()=>{},1000);`, { mode: 0o700 });
  const controller = new AbortController();
  const pending = renderDrawio(exe, dir, controller.signal);
  // Attach immediately so cancellation cannot become an unhandled rejection.
  const failed = assert.rejects(pending, /cancelled/);
  let ids: { parent: number; child: number } | undefined;
  for (let n = 0; n < 100; n++) {
    try { ids = JSON.parse(await readFile(join(dir, 'child.json'), 'utf8')); break; } catch {}
    await new Promise(r => setTimeout(r, 10));
  }
  assert.ok(ids, 'fake renderer started'); controller.abort(); await failed;
  // Give the OS time to reap the killed helper.
  for (let n = 0; n < 100; n++) {
    try { process.kill(ids.child, 0); } catch { break; }
    await new Promise(r => setTimeout(r, 10));
  }
  for (const pid of [ids.parent, ids.child]) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});


test('extract accepts legacy text and bounds compressed metadata before decoding', () => {
  const withText = (type: string, payload: Buffer) => {
    const part = Buffer.alloc(payload.length + 12);
    part.writeUInt32BE(payload.length); part.write(type, 4); payload.copy(part, 8);
    part.writeUInt32BE(crc32(part.subarray(4, -4)), part.length - 4);
    return Buffer.concat([png.subarray(0, -12), part, png.subarray(-12)]);
  };
  assert.equal(extractDiagram(withText('tEXt', Buffer.from('mxfile\0' + encodeURIComponent(xml)))), xml);
  const bomb = withText('zTXt', Buffer.concat([Buffer.from('mxGraphModel\0\0'), deflateSync(Buffer.alloc(MAX_XML * 4, 120))]));
  assert.throws(() => extractDiagram(bomb), /oversized/);
});
