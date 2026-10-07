import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
function untar(gzip) {
  const data = gunzipSync(gzip), result = new Map();
  for (let offset = 0; data[offset];) {
    const header = data.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString().split('\0')[0];
    const size = parseInt(header.subarray(124, 136).toString(), 8);
    const mode = parseInt(header.subarray(100, 108).toString(), 8);
    const expected = parseInt(header.subarray(148, 156).toString(), 8);
    const sum = header.reduce((a, b, i) => a + (i >= 148 && i < 156 ? 32 : b), 0);
    assert.equal(sum, expected, name);
    result.set(name, { mode, data: data.subarray(offset + 512, offset + 512 + size) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return result;
}
test('IPK is reproducible, root-owned paths and private settings, with no core overwrites', async () => {
  execFileSync(process.execPath, ['build.mjs'], { cwd: root });
  const filename = resolve(root, 'dist/luci-app-collectd-mqtt_0.1.0-1_all.ipk');
  const first = await readFile(filename);
  execFileSync(process.execPath, ['build.mjs'], { cwd: root });
  assert.deepEqual(await readFile(filename), first);
  const outer = untar(first);
  assert.equal(outer.get('./debian-binary').data.toString(), '2.0\n');
  const files = untar(outer.get('./data.tar.gz').data);
  assert.equal(files.get('./etc/config/collectd_mqtt_ui').mode, 0o600);
  assert.equal(files.get('./usr/libexec/collectd-mqtt-ui-render').mode, 0o755);
  assert(!files.has('./usr/libexec/stat-genconfig'));
  assert(!files.has('./etc/config/luci_statistics'));
  assert(!/option password/.test(files.get('./etc/config/collectd_mqtt_ui').data.toString()));
  for (const [name, value] of files) {
    assert(!name.includes('..'));
    assert(!value.data.includes(13), `CRLF: ${name}`);
    assert(!/emqxsl\.cn|192\.168\./.test(value.data.toString()), `Environment-specific value: ${name}`);
    if (name.endsWith('.json')) JSON.parse(value.data.toString());
    if (name.endsWith('.js')) new Function(value.data.toString());
  }
  const checksum = (await readFile(`${filename}.sha256`, 'utf8')).split(' ')[0];
  assert.equal(createHash('sha256').update(first).digest('hex'), checksum);
});
