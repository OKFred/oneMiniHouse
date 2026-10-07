import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Socket, type AddressInfo } from 'node:net';
import { lightRequest, readLight } from '../src/light.ts';
import { crc16 } from '../src/modbus.ts';
import { validateConfig, type LightDeviceConfig } from '../src/config.ts';
import { drivers } from '../src/runner.ts';

const device: LightDeviceConfig = { id:'light-modbus-21', driver:'modbus-light-u32-rtu-tcp', host:'127.0.0.1', port:1, slaveId:33, intervalSeconds:60, timeoutSeconds:8 };
const reply = (value=1447, slave=33) => { const b=Buffer.from([slave,3,4,0,0,0,0,0,0]); b.writeUInt32BE(value,3); b.writeUInt16LE(crc16(b.subarray(0,7)),7); return b; };
async function serverRun(handler: (b: Buffer, s: Socket) => void, work: (d: LightDeviceConfig) => Promise<void>) {
  const sockets=new Set<Socket>();
  const server=createServer(s=>{ sockets.add(s); s.on('error',()=>{}); s.on('close',()=>sockets.delete(s)); let bytes=Buffer.alloc(0); s.on('data',b=>{ bytes=Buffer.concat([bytes,b]); if(bytes.length>=8) handler(bytes,s); }); });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try { await work({...device,port:(server.address() as AddressInfo).port}); }
  finally { for(const s of sockets)s.destroy(); await new Promise<void>(resolve=>server.close(() => resolve())); }
}
test('historical query bytes and separate light identity',()=>{
  assert.equal(lightRequest(33).toString('hex'),'21030002000262ab');
  assert.throws(()=>lightRequest(0));
  const c=validateConfig({siteId:'example-home',gatewayId:'test',mqtt:{url:'mqtts://example.com:8883',clientId:'test',username:'test',passwordFile:'/none',topicPrefix:'iot/v1/example-home/test'},queue:{maxAgeDays:7,maxRows:100},devices:[device]});
  assert.equal(c.devices[0].driver,device.driver); assert.ok(drivers[device.driver]);
});
test('fragmented response preserves raw unsigned value and CRC trace',async()=>{
  const seen: import('../src/frames.ts').ProtocolFrame[]=[];
  await serverRun((b,s)=>{ assert.equal(b.toString('hex'),'21030002000262ab'); const r=reply(0xffffffff); s.write(r.subarray(0,2)); setTimeout(()=>s.write(r.subarray(2)),5); },async d=>{
    const r=await readLight(d,new AbortController().signal,f=>seen.push(f));
    assert.deepEqual(r.metrics,{light_raw_count:4294967295,illuminance_lux:4294967.295});
    assert.equal(r.source.measurement_unit,'lux'); assert.equal(r.source.scale_factor,0.001);
    assert.equal(r.source.manufacturer_protocol_verified,false);
  });
  assert.deepEqual(seen.map(x=>x.direction),['tx','rx']); assert.ok(seen.every(x=>x.crc_valid));
});
test('B-RS-L30 real frames retain raw counts and convert to lux exactly once',async()=>{
  for(const [hex,raw,lux] of [
    ['210304000001b51bd6',437,0.437],
    ['21030400a93429dccf',11088937,11088.937],
  ] as const) await serverRun((_b,s)=>s.write(Buffer.from(hex,'hex')),async d=>{
    const r=await readLight(d,new AbortController().signal);
    assert.deepEqual(r.metrics,{light_raw_count:raw,illuminance_lux:lux});
    assert.equal(r.source.crc_valid,true);
  });
});
test('bad CRC and another slave cannot become readings',async()=>{
  for(const kind of ['crc','slave']) await serverRun((b,s)=>{ const r=reply(1447,kind==='slave'?34:33); if(kind==='crc')r[8]^=1; s.write(r); },async d=>{
    await assert.rejects(readLight(d,new AbortController().signal),kind==='crc'?/CRC/:/slave/);
  });
});
test('no response times out and cancellation closes the connection',async()=>{
  await serverRun(()=>{},async d=>{
    await assert.rejects(readLight(d,new AbortController().signal,undefined,40),/timeout/);
    const abort=new AbortController(); const p=readLight(d,abort.signal); setTimeout(()=>abort.abort(),20); await assert.rejects(p,/cancelled/);
  });
});
test('zero is a valid raw reading, storage failures do not emit a sample',async()=>{
  await serverRun((b,s)=>s.write(reply(0)),async d=>assert.deepEqual((await readLight(d,new AbortController().signal)).metrics,{light_raw_count:0,illuminance_lux:0}));
  await serverRun((b,s)=>s.write(reply()),async d=>assert.rejects(readLight(d,new AbortController().signal,()=>{throw new Error('storage unavailable');}),/storage unavailable/));
});
