import { parseDocument } from 'htmlparser2';
import sanitizeHtml from 'sanitize-html';
import { inflateRawSync } from 'node:zlib';
import { PublicError } from './errors.js';

export const MAX_XML = 1024 * 1024;
function fail(message: string): never { throw new PublicError(message); }
const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
type Element = { name: string; attrs: Record<string, string>; children: Element[]; text: string };
const children: Record<string, string[]> = {
  mxfile: ['diagram'], diagram: ['mxGraphModel'], mxGraphModel: ['root'],
  root: ['mxCell', 'object', 'UserObject'], object: ['mxCell'], UserObject: ['mxCell'],
  mxCell: ['mxGeometry'], mxGeometry: ['mxPoint', 'mxRectangle', 'Array'], Array: ['mxPoint'], mxPoint: [], mxRectangle: [],
};
const attributes: Record<string, string> = {
  mxfile: 'host modified agent etag version type compressed', diagram: 'id name',
  mxGraphModel: 'dx dy grid gridSize guides tooltips connect arrows fold page pageScale pageWidth pageHeight math shadow background',
  root: '', mxCell: 'id value style parent source target vertex edge connectable visible collapsed',
  object: 'id label', UserObject: 'id label',
  mxGeometry: 'x y width height relative as', mxPoint: 'x y as', mxRectangle: 'x y width height as', Array: 'as',
};
const htmlTags = ['b', 'strong', 'i', 'em', 'u', 's', 'br', 'p', 'div', 'span', 'sub', 'sup', 'ul', 'ol', 'li', 'font'];
const css = /^(?:color|background-color|font-family|font-size|font-weight|font-style|text-align|text-decoration|white-space)$/;
const cssValue = /^[\p{L}\p{N}\s#.,%'"()+-]+$/u;

// Only formatting HTML. No images, links, CSS resources, scripts or nested SVG.
function label(value: string, html: boolean): string {
  const doc = parseDocument(value);
  let count = 0;
  const visit = (nodes: typeof doc.children, depth = 0) => {
    if (depth > 50) fail('Diagram label nesting exceeds 50 levels.');
    for (const n of nodes) {
      if (++count > 10000) fail('Diagram label is too complex.');
      if (n.type === 'text') continue;
      if (n.type !== 'tag' || !htmlTags.includes(n.name)) fail('Diagram labels support formatting HTML only. Remove images, links and active content.');
      for (const [key, v] of Object.entries(n.attribs)) {
        if (key === 'style') {
          for (const declaration of v.split(';').filter(s => s.trim())) {
            const at = declaration.indexOf(':');
            if (at < 0 || !css.test(declaration.slice(0, at).trim()) || !cssValue.test(declaration.slice(at + 1).trim())) fail('Unsupported CSS in a diagram label.');
          }
        } else if (!(n.name === 'font' && ['face', 'color', 'size'].includes(key) && cssValue.test(v))) fail('Unsupported attribute in a diagram label.');
      }
      visit(n.children, depth + 1);
    }
  };
  visit(doc.children);
  return html ? sanitizeHtml(value, { allowedTags: htmlTags, allowedAttributes: { '*': ['style'], font: ['face', 'color', 'size'] } }) : value;
}

// Re-serialize an allowlisted model rather than passing arbitrary XML to mxCodec.
// The original bytes are embedded separately after rendering for lossless editing.
export function diagramSource(xml: string, page?: number): { renderXml: string; pages: number; page: number } {
  if (!xml || Buffer.byteLength(xml) > MAX_XML) fail('Diagram XML must be between 1 byte and 1 MiB.');
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i.test(xml)) fail('DTD, entities and CDATA are not supported.');
  let count = 0, expanded = Buffer.byteLength(xml);
  const parse = (source: string): Element => {
    const doc = parseDocument(source.replace(/^\s*<\?xml\s[^?]*\?>/, ''), { xmlMode: true });
    const convert = (n: typeof doc.children[number], depth: number): Element => {
      if (depth > 50 || ++count > 10_000) fail('Diagram is too complex (50 levels / 10000 elements).');
      if (n.type !== 'tag' || !Object.hasOwn(children, n.name)) fail('Unsupported draw.io XML element.');
      const el: Element = { name: n.name, attrs: {}, children: [], text: '' };
      for (const [key, v] of Object.entries(n.attribs)) {
        if (!attributes[n.name].split(' ').includes(key)) fail(`Unsupported ${n.name} attribute: ${key}.`);
        if (['id', 'parent', 'source', 'target'].includes(key) && ['__proto__', 'prototype', 'constructor'].includes(v)) fail('Reserved diagram identifier.');
        if (key === 'math' && v !== '0') fail('Math rendering is not supported.');
        if (key === 'as' && !({ mxGeometry: ['geometry'], mxPoint: ['sourcePoint', 'targetPoint', 'offset'], mxRectangle: ['alternateBounds'], Array: ['points'] } as Record<string, string[]>)[n.name]?.includes(v)) fail('Unsupported geometry field.');
        // Resources can be hidden in styles, including compressed custom stencils.
        if (key === 'style' && /[<>{}\\]|(?:image|fontSource|stencil)\s*[=(]|(?:url|expression)\s*\(|(?:https?|file|data|javascript):/i.test(v)) fail('External resources, images and custom stencils are not supported.');
        if (['x', 'y', 'width', 'height', 'pageWidth', 'pageHeight', 'pageScale', 'dx', 'dy'].includes(key) && (!Number.isFinite(Number(v)) || Math.abs(Number(v)) > 100_000)) fail('Diagram geometry is outside the supported range.');
        const cell = n.name === 'object' || n.name === 'UserObject' ? n.children.find(c => c.type === 'tag' && c.name === 'mxCell') : n;
        const html = cell?.type === 'tag' && /(?:^|;)html=1(?:;|$)/.test(cell.attribs.style ?? '');
        el.attrs[key] = key === 'value' || key === 'label' ? label(v, html) : v;
      }
      for (const c of n.children) {
        if (c.type === 'text') el.text += c.data;
        else if (c.type !== 'comment') el.children.push(convert(c, depth + 1));
      }
      if (el.children.some(c => !children[el.name].includes(c.name))) fail(`Invalid children of ${el.name}.`);
      if (el.text.trim() && el.name !== 'diagram') fail('Unexpected text in draw.io XML.');
      return el;
    };
    const roots = doc.children.filter(n => n.type !== 'comment' && !(n.type === 'text' && !n.data.trim()));
    if (roots.length !== 1) fail('Expected one draw.io XML document.');
    return convert(roots[0], 0);
  };
  const root = parse(xml);
  if (root.name !== 'mxfile' && root.name !== 'mxGraphModel') fail('Expected mxfile or mxGraphModel.');
  const pages = root.name === 'mxfile' ? root.children : [{ name: 'diagram', attrs: {}, children: [root], text: '' }];
  if (!pages.length || pages.length > 100) fail('Expected 1 to 100 diagram pages.');
  for (const p of pages) {
    if (p.text.trim()) {
      if (p.children.length || !/^[A-Za-z0-9+/=\s]+$/.test(p.text)) fail('Invalid compressed diagram.');
      let decoded: string;
      try { decoded = decodeURIComponent(inflateRawSync(Buffer.from(p.text.trim(), 'base64'), { maxOutputLength: MAX_XML * 3 }).toString('utf8')); }
      catch { fail('Cannot decode compressed diagram within the size limit.'); }
      expanded += Buffer.byteLength(decoded!);
      if (expanded > MAX_XML * 2) fail('Expanded diagram exceeds 2 MiB.');
      p.children = [parse(decoded!)]; p.text = '';
    }
    if (p.children.length !== 1 || p.children[0].name !== 'mxGraphModel' || p.children[0].children.length !== 1) fail('Each page must contain one mxGraphModel with a root.');
  }
  if (page === undefined && pages.length > 1) fail(`Diagram has ${pages.length} pages. Choose page (1-based).`);
  const selected = page ?? 1;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > pages.length) fail(`Page must be between 1 and ${pages.length}.`);
  const serialize = (e: Element): string => `<${e.name}${Object.entries(e.attrs).map(([k, v]) => ` ${k}="${escape(v)}"`).join('')}>${e.children.map(serialize).join('')}</${e.name}>`;
  return { renderXml: serialize(pages[selected - 1].children[0]), pages: pages.length, page: selected };
}
