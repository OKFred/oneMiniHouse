import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const root = dirname(fileURLToPath(import.meta.url));
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const name = 'luci-app-collectd-mqtt';
const output = resolve(root, 'dist', `${name}_${version}-1_all.ipk`);
const hash = value => createHash('sha256').update(value).digest('hex');

// OpenWrt 23.05 IPK uses a tar.gz outer container, not Debian's ar container.
export function tar(entries) {
  const blocks = [];
  for (const { name, data, mode = 0o644, directory = false } of entries) {
    if (Buffer.byteLength(name) > 100) throw new Error(`Tar path too long: ${name}`);
    const header = Buffer.alloc(512);
    const put = (value, start, length) => header.write(value, start, length, 'ascii');
    put(name, 0, 100);
    put(`${mode.toString(8).padStart(7, '0')}\0`, 100, 8);
    put('0000000\0', 108, 8); put('0000000\0', 116, 8);
    put(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12);
    put('00000000000\0', 136, 12);
    put('        ', 148, 8); put(directory ? '5' : '0', 156, 1);
    put('ustar\0', 257, 6); put('00', 263, 2);
    put('root', 265, 32); put('root', 297, 32);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    put(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]), { level: 9 });
}

async function collect(directory, base = directory) {
  const result = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push({ name: './' + relative(base, path).replaceAll('\\', '/') + '/', data: Buffer.alloc(0), mode: 0o755, directory: true });
      result.push(...await collect(path, base));
    }
    else {
      const name = relative(base, path).replaceAll('\\', '/');
      // Normalize checkout line endings; preserve exact mode in the archive.
      const data = Buffer.from((await readFile(path, 'utf8')).replaceAll('\r\n', '\n'));
      const mode = name === 'etc/config/collectd_mqtt_ui' ? 0o600
        : /^(etc\/init.d|usr\/libexec)\//.test(name) || base.endsWith('control') ? 0o755 : 0o644;
      result.push({ name: `./${name}`, data, mode });
    }
  }
  return result;
}
const payload = await collect(join(root, 'files'));
const control = await collect(join(root, 'control'));
control.push({ name: './control', data: Buffer.from([
  `Package: ${name}`, `Version: ${version}-1`, 'Architecture: all',
  'Maintainer: oneMiniHouse', 'Section: luci', 'Priority: optional', 'License: MIT',
  'Depends: luci-base, luci-app-statistics, collectd-mod-mqtt, ca-bundle, uci',
  `Installed-Size: ${payload.reduce((sum, f) => sum + f.data.length, 0)}`,
  'Description: Standalone collectd MQTT settings for OpenWrt 23.05 LuCI.', '',
].join('\n')) });
control.push({ name: './conffiles', data: Buffer.from('/etc/config/collectd_mqtt_ui\n') });
const packageData = tar([
  { name: './debian-binary', data: Buffer.from('2.0\n') },
  { name: './control.tar.gz', data: tar(control) },
  { name: './data.tar.gz', data: tar(payload) },
]);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, packageData);
await writeFile(`${output}.sha256`, `${hash(packageData)}  ${output.split(/[\\/]/).at(-1)}\n`);
await writeFile(join(root, 'dist', 'manifest.json'), JSON.stringify({
  name, version: `${version}-1`, bytes: packageData.length, sha256: hash(packageData),
  files: payload.map(f => ({ path: f.name, directory: f.directory || false, mode: f.mode.toString(8), sha256: hash(f.data) })),
}, null, 2) + '\n');
console.log(`${output}\n${packageData.length} bytes\nSHA256 ${hash(packageData)}`);
