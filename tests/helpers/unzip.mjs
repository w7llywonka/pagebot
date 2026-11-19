// A small zip reader for the extension tests: the end record, then the central directory, then each local header and its
// data (stored or deflated). It checks the structure as it goes and throws on anything it doesn't expect.
import zlib from 'node:zlib';

export function readZip(buf) {
  const end = buf.length - 22;
  if (buf.readUInt32LE(end) !== 0x06054b50) throw new Error('no end record where it should be (a comment, or not a zip)');
  const count = buf.readUInt16LE(end + 10), cdSize = buf.readUInt32LE(end + 12), cdAt = buf.readUInt32LE(end + 16);
  if (buf.readUInt16LE(end + 8) !== count || cdAt + cdSize !== end) throw new Error('the end record and the central directory disagree');
  const files = [];
  let p = cdAt;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`central directory entry ${i} has no signature`);
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), time = buf.readUInt16LE(p + 12), date = buf.readUInt16LE(p + 14);
    const crc = buf.readUInt32LE(p + 16), packed = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const attrs = buf.readUInt32LE(p + 38), at = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    // the local header must say the same
    if (buf.readUInt32LE(at) !== 0x04034b50) throw new Error(`${name}: no local header`);
    const lName = buf.subarray(at + 30, at + 30 + buf.readUInt16LE(at + 26)).toString('utf8');
    if (lName !== name || buf.readUInt16LE(at + 8) !== method || buf.readUInt32LE(at + 14) !== crc || buf.readUInt32LE(at + 18) !== packed || buf.readUInt32LE(at + 22) !== size)
      throw new Error(`${name}: the local header and the central directory disagree`);
    const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28), raw = buf.subarray(start, start + packed);
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? zlib.inflateRawSync(raw) : null;
    if (!data) throw new Error(`${name}: compression method ${method}`);
    if (data.length !== size) throw new Error(`${name}: size ${data.length}, the header says ${size}`);
    files.push({ name, data, method, crc, flags, time, date, attrs });
  }
  return files;
}
