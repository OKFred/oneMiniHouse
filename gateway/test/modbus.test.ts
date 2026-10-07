import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Socket, type AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { validateConfig, type ModbusDeviceConfig } from '../src/config.ts';
import { crc16, decodeRegisters, readModbus, readRequest, responseData, RtuFrames, validCrc } from '../src/modbus.ts';
import { FrameStorageError, type ProtocolFrame } from '../src/frames.ts';

// Synthetic response values for transport/unit tests; these are not a live capture.
const energy = Buffer.alloc(4); energy.writeFloatBE(18004.23);
const params = Buffer.alloc(32);
for (const [offset, value] of [[0,230],[4,0.8],[8,0.1759],[12,0.025],[16,999],[20,0.956],[24,1234],[28,50.01]]) params.writeFloatBE(value, offset);
function reply(data: Buffer, unit = 88) {
  const b = Buffer.concat([Buffer.from([unit,3,data.length]), data, Buffer.alloc(2)]);
  b.writeUInt16LE(crc16(b.subarray(0,-2)),b.length-2); return b;
}
const device: ModbusDeviceConfig = { id:'meter',driver:'chint-ddsu666-rtu-tcp',host:'127.0.0.1',port:1,slaveId:88,intervalSeconds:60,timeoutSeconds:5 };
async function serverRun(handler: (request: Buffer, socket: Socket, connection: number) => void, work: (d: ModbusDeviceConfig) => Promise<void>) {
  const sockets = new Set<Socket>(); let connections = 0;
  const server = createServer(socket => {
    sockets.add(socket); const n = ++connections; let bytes: Buffer = Buffer.alloc(0);
    socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    socket.on('data', data => {
      bytes = Buffer.concat([bytes,data]);
      while (bytes.length >= 8) { const request = Buffer.from(bytes.subarray(0,8)); bytes = bytes.subarray(8); handler(request,socket,n); }
    });
  });
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  try { await work({...device,port:(server.address() as AddressInfo).port}); }
  finally { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
const normal = (request: Buffer, socket: Socket) => socket.write(reply(request.readUInt16BE(2) === 0x4000 ? energy : params));

test('DDSU666 FC03 request bytes match existing real requests and block other registers', () => {
  assert.equal(readRequest(88,0x4000,2).toString('hex'),'580340000002dd02');
  assert.equal(readRequest(88,0x2000,16).toString('hex'),'580320000010430f');
  assert.throws(() => readRequest(88,0x4000,4), /Only/);
  assert.throws(() => readRequest(0,0x4000,2), /slave/);
});
test('unchanged legacy repository response examples verify both CRCs and 0x200E frequency', () => {
  // Copied verbatim from tcp_client/client/meterPower.js:5-7 (also utils/meterPower.js).
  // The old comments call them examples; their capture date/origin is unknown.
  const oldEnergy = Buffer.from('5803043F9333339BEA','hex');
  const oldParams = Buffer.from('5803204364CCCD000000000000000000000000000000003F800000000000004247EB85ACC2','hex');
  assert.equal(validCrc(oldEnergy),true); assert.equal(validCrc(oldParams),true);
  const values=decodeRegisters(responseData(oldEnergy,88,2),responseData(oldParams,88,16));
  assert.ok(Math.abs(values.energy_kwh-1.15)<0.00001);
  assert.ok(Math.abs(values.voltage_v-228.8)<0.0001);
  assert.ok(Math.abs(values.frequency_hz-49.98)<0.0001);
  assert.equal(values.power_factor,1);
});
test('RTU stream assembles every split boundary and extracts coalesced frames', () => {
  for (const bytes of [reply(energy),reply(params)]) {
    for(let i=1;i<bytes.length;i++) {
      const parser = new RtuFrames(); assert.deepEqual(parser.push(bytes.subarray(0,i)),[]);
      assert.deepEqual(parser.push(bytes.subarray(i)),[bytes]);
    }
  }
  assert.deepEqual(new RtuFrames().push(Buffer.concat([reply(energy),reply(params)])),[reply(energy),reply(params)]);
  assert.throws(() => new RtuFrames().push(Buffer.from('Port already in use')), /non-Modbus/);
  assert.throws(() => new RtuFrames().push(Buffer.alloc(513)), /Oversized/);
});
test('RTU validates CRC, address, exception response and expected response size', () => {
  const bad = reply(energy); bad[4] ^= 1;
  assert.equal(validCrc(bad),false); assert.throws(() => responseData(bad,88,2),/CRC/);
  assert.throws(() => responseData(reply(energy,87),88,2),/slave/);
  assert.throws(() => responseData(reply(energy),88,16),/registers/);
  const exception = Buffer.from([88,0x83,2,0,0]); exception.writeUInt16LE(crc16(exception.subarray(0,3)),3);
  assert.throws(() => responseData(exception,88,2),/exception 2/);
});
test('DDSU666 units and 0x200E frequency mapping ignore reserved registers', () => {
  const values = decodeRegisters(energy,params);
  assert.ok(Math.abs(values.power_w-175.9)<0.001); assert.ok(Math.abs(values.reactive_power_var-25)<0.001);
  assert.ok(Math.abs(values.frequency_hz-50.01)<0.001); assert.equal('apparent_power_va' in values,false);
  const invalid=Buffer.from(params); invalid.writeFloatBE(NaN,0);
  assert.throws(() => decodeRegisters(energy,invalid),/Non-finite/);
});
test('Modbus configuration needs no adapter and validates endpoints and duplicate slaves', () => {
  const input = JSON.parse(readFileSync(new URL('../config/modbus.example.json',import.meta.url),'utf8'));
  assert.equal(validateConfig(input).adapter,undefined);
  for (const mutate of [ (c:any)=>c.devices[0].slaveId=0, (c:any)=>c.devices[0].port=65536, (c:any)=>c.devices.push({...c.devices[0],id:'second'}), (c:any)=>c.frameQueue.maxAgeDays=31 ]) {
    const c=structuredClone(input); mutate(c); assert.throws(()=>validateConfig(c));
  }
});
test('TCP collection serializes both reads, accepts fragmented bytes and emits four independent traces', async () => {
  const observed: ProtocolFrame[]=[]; const registers:number[]=[];
  await serverRun((request,socket)=>{
    registers.push(request.readUInt16BE(2)); const bytes=reply(registers.at(-1)===0x4000?energy:params);
    socket.write(bytes.subarray(0,2)); setTimeout(()=>socket.write(bytes.subarray(2)),5);
  }, async d=>{
    const result=await readModbus(d,new AbortController().signal,f=>observed.push(f));
    assert.ok(result.metrics.energy_kwh>18004); assert.equal('wire_hex' in result.source,false);
  });
  assert.deepEqual(registers,[0x4000,0x2000]); assert.deepEqual(observed.map(f=>f.direction),['tx','rx','tx','rx']);
  assert.ok(observed.every(f=>f.crc_valid));
});
test('response timeout discards connection and retries the whole collection once', async () => {
  const connections = new Set<number>();
  await serverRun((request,socket,n)=>{ connections.add(n); if(n>1) normal(request,socket); }, async d=>{
    const result=await readModbus(d,new AbortController().signal,undefined,{responseMs:40,retryDelayMs:0});
    assert.ok(result.metrics.voltage_v===230);
  });
  assert.deepEqual([...connections],[1,2]);
});
test('bad CRC is traced as invalid and cannot produce a reading', async () => {
  const observed:ProtocolFrame[]=[];
  await serverRun((_request,socket)=>{ const b=reply(energy); b[b.length-1]^=1; socket.write(b); }, async d=>{
    await assert.rejects(readModbus(d,new AbortController().signal,f=>observed.push(f),{retryDelayMs:0}),/CRC/);
  });
  assert.deepEqual(observed.filter(f=>f.direction==='rx').map(f=>f.crc_valid),[false,false]);
});
test('duplicate coalesced replies cannot be matched to later requests', async () => {
  await serverRun((request,socket)=>{ const b=reply(request.readUInt16BE(2)===0x4000?energy:params); socket.write(Buffer.concat([b,b])); },async d=>{
    await assert.rejects(readModbus(d,new AbortController().signal,undefined,{retryDelayMs:0}),/Unsolicited/);
  });
});
test('cancellation closes pending TCP reads promptly and frame-storage failure is not retried', async () => {
  await serverRun(()=>{},async d=>{
    const abort=new AbortController(); const timer=setTimeout(()=>abort.abort(),30);
    try { await assert.rejects(readModbus(d,abort.signal),/cancel|abort|timed out/i); }
    finally { clearTimeout(timer); }
  });
  let traces=0;
  await serverRun(normal,async d=>{
    await assert.rejects(readModbus(d,new AbortController().signal,()=>{ traces++; throw new FrameStorageError('disk full'); }),FrameStorageError);
  });
  assert.equal(traces,1);
});
