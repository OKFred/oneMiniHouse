// Original geometric artwork for oneMiniHouse. No third-party image inputs.
// Run with Node.js to reproduce SVG menu icons and PNG mini-program tab icons.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const root = fileURLToPath(new URL("../static/", import.meta.url));
const paths = {
    electricity: '<path d="M28 5 12 26h12l-3 17 16-23H25z"/>',
    tempHumidity: '<path d="M15 27V11a5 5 0 0 1 10 0v16a9 9 0 1 1-10 0Z"/><path d="M20 16v17"/><circle cx="20" cy="35" r="3"/><path d="M36 17c-8 10-7 16 0 16s8-6 0-16Z"/>',
    sound: '<path d="M7 19h8l10-8v26l-10-8H7Z"/><path d="M31 17c4 4 4 10 0 14m6-19c7 7 7 17 0 24"/>',
    light: '<circle cx="24" cy="24" r="9"/><path d="M24 3v6m0 30v6M3 24h6m30 0h6M9 9l4 4m22 22 4 4M9 39l4-4m22-22 4-4"/>',
    mix: '<rect x="6" y="6" width="14" height="14" rx="3"/><rect x="28" y="6" width="14" height="14" rx="3"/><rect x="6" y="28" width="14" height="14" rx="3"/><path d="M35 28v14m-7-7h14"/>',
};
fs.mkdirSync(path.join(root, "assets"), { recursive: true });
fs.mkdirSync(path.join(root, "tabbar"), { recursive: true });
for (const [name, body] of Object.entries(paths)) {
    fs.writeFileSync(path.join(root, "assets", `${name}.svg`), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" fill="none" stroke="#275d65" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">${body}</svg>\n`);
}

function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
    const payload = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(payload));
    return Buffer.concat([length, payload, checksum]);
}
function line(x, y, ax, ay, bx, by, width = 3) {
    const length = (bx - ax) ** 2 + (by - ay) ** 2;
    const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / length));
    return Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay)) <= width / 2;
}
const home = (x, y) => [[8, 22, 24, 8], [24, 8, 40, 22], [13, 19, 13, 39], [35, 19, 35, 39], [13, 39, 35, 39], [20, 39, 20, 28], [20, 28, 28, 28], [28, 28, 28, 39]].some((points) => line(x, y, ...points));
const me = (x, y) => Math.abs(Math.hypot(x - 24, y - 15) - 7) < 1.5 ||
    (y >= 28 && Math.abs(Math.hypot(x - 24, y - 39) - 13) < 1.5) || line(x, y, 11, 40, 37, 40);
for (const [name, shape] of Object.entries({ home, me })) {
    for (const [state, color] of Object.entries({ selected: 24, unselected: 172 })) {
        const size = 72;
        const raw = Buffer.alloc((size * 4 + 1) * size);
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
            let coverage = 0;
            for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
                if (shape((x + (sx + 0.5) / 4) * 48 / size, (y + (sy + 0.5) / 4) * 48 / size)) coverage++;
            }
            const offset = y * (size * 4 + 1) + 1 + x * 4;
            raw.set([color, color, color, Math.round(255 * coverage / 16)], offset);
        }
        const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
        fs.writeFileSync(path.join(root, "tabbar", `${name}_${state}.png`), Buffer.concat([
            Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
        ]));
    }
}
