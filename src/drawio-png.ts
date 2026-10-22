import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { PublicError } from './errors.js';
import { MAX_XML } from './drawio-source.js';

export const MAX_PNG = 32 * 1024 * 1024;
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length); out.write(type, 4, 4, 'ascii'); data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, -4)), out.length - 4);
  return out;
}
function parts(png: Buffer): { type: string; data: Buffer; raw: Buffer }[] {
  if (png.length > MAX_PNG || !png.subarray(0, 8).equals(signature)) throw new PublicError('Expected a PNG of at most 32 MiB.');
  const result = []; let offset = 8;
  while (offset < png.length) {
    if (offset + 12 > png.length) throw new PublicError('Truncated PNG.');
    const length = png.readUInt32BE(offset), end = offset + length + 12;
    if (end > png.length || crc32(png.subarray(offset + 4, end - 4)) !== png.readUInt32BE(end - 4)) throw new PublicError('Invalid PNG chunk or checksum.');
    const type = png.toString('ascii', offset + 4, offset + 8);
    if (result.length === 0 && (type !== 'IHDR' || length !== 13)) throw new PublicError('Invalid PNG header.');
    result.push({ type, data: png.subarray(offset + 8, end - 4), raw: png.subarray(offset, end) }); offset = end;
    if (type === 'IEND') { if (length || end !== png.length) throw new PublicError('Invalid PNG end.'); break; }
  }
  if (result.at(-1)?.type !== 'IEND' || !result.some(p => p.type === 'IDAT')) throw new PublicError('Incomplete PNG.');
  const width = result[0].data.readUInt32BE(), height = result[0].data.readUInt32BE(4);
  if (!width || !height || width > 8192 || height > 8192 || width * height > 16_777_216) throw new PublicError('PNG exceeds 8192 pixels per side or 16 megapixels.');
  return result;
}
function sourceChunk(type: string, data: Buffer): boolean {
  return ['tEXt', 'zTXt'].includes(type) && ['mxGraphModel', 'mxfile'].includes(data.toString('latin1', 0, data.indexOf(0)));
}
export function extractDiagram(png: Buffer): string {
  const candidates = parts(png).filter(p => sourceChunk(p.type, p.data));
  if (candidates.length !== 1) throw new PublicError('Expected exactly one embedded draw.io source.');
  const { type, data } = candidates[0], at = data.indexOf(0);
  try {
    if (type === 'zTXt' && data[at + 1] !== 0) throw new Error('compression');
    const encoded = type === 'zTXt' ? inflateSync(data.subarray(at + 2), { maxOutputLength: MAX_XML * 3 }) : data.subarray(at + 1);
    if (encoded.length > MAX_XML * 3) throw new Error('size');
    const xml = decodeURIComponent(encoded.toString('utf8'));
    if (!xml || Buffer.byteLength(xml) > MAX_XML) throw new Error('size');
    return xml;
  } catch { throw new PublicError('Invalid or oversized embedded draw.io source.'); }
}
export function embedDiagram(png: Buffer, xml: string): Buffer {
  if (!xml || Buffer.byteLength(xml) > MAX_XML) throw new PublicError('Diagram source exceeds 1 MiB.');
  const chunks = parts(png).filter(p => !sourceChunk(p.type, p.data));
  const source = chunk('zTXt', Buffer.concat([Buffer.from('mxGraphModel\0\0'), deflateSync(Buffer.from(encodeURIComponent(xml)))]));
  const result = Buffer.concat([signature, ...chunks.slice(0, -1).map(p => p.raw), source, chunks.at(-1)!.raw]);
  if (result.length > MAX_PNG) throw new PublicError('Rendered PNG exceeds 32 MiB.');
  return result;
}
