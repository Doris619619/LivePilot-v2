/** 生成与网站圆点标识对应的 PNG/ICO，不引入额外绘图依赖。 */
import { deflateSync } from "node:zlib";
import { writeFile, mkdir } from "node:fs/promises";
/** PNG 标准 CRC32。 */
function crc(buffer) { let n = 0xffffffff; for (const b of buffer) { n ^= b; for (let k = 0; k < 8; k++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0); } return (n ^ 0xffffffff) >>> 0; }
/** 编码一个 PNG chunk。 */
function chunk(type, value) { const name = Buffer.from(type); const payload = Buffer.concat([name, value]); const head = Buffer.alloc(4); head.writeUInt32BE(value.length); const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(payload)); return Buffer.concat([head, payload, tail]); }
/** 256px 圆环图标同时用于安装器与托盘。 */
export async function icon(root) {
  const size = 256; const pixels = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { const d = Math.hypot(x - 127.5, y - 127.5); const color = d < 35 ? [40, 94, 213, 255] : d >= 79 && d <= 94 ? [39, 51, 69, 255] : d < 105 ? [255, 255, 255, 255] : [0, 0, 0, 0]; pixels.set(color, y * (size * 4 + 1) + 1 + x * 4); }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
  const ico = Buffer.alloc(22); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12); ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18);
  await mkdir(root, { recursive: true }); await writeFile(root + "/icon.png", png); await writeFile(root + "/icon.ico", Buffer.concat([ico, png]));
}
