import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateConfig,type TemperatureDeviceConfig} from '../src/config.ts';
import {parseTemperatures,readHostTemperature,temperatureSshArgs,TEMPERATURE_COMMAND} from '../src/temperature.ts';
import {collectionGroups} from '../src/scheduler.ts';

const device=JSON.parse(readFileSync(new URL('../config/temperature.device.example.json',import.meta.url),'utf8')) as TemperatureDeviceConfig;
const response='one-minihouse-temperatures-v1\nthermal\tcpu-thermal\ttemp\t53900\nthermal\tddr-thermal\ttemp\t55400\n';
test('host exposes CPU and DDR Celsius only, with no fan metric',()=>{
  assert.deepEqual(parseTemperatures(response,device.sensors),{cpu_temperature_c:53.9,ddr_temperature_c:55.4});
  assert.ok(!Object.keys(parseTemperatures(response,device.sensors)).some(k=>k.includes('fan')));
  assert.equal(parseTemperatures(response.replace('53900','0'),device.sensors).cpu_temperature_c,0);
});
test('missing, ambiguous, malformed and out-of-range channels fail instead of emitting zeros',()=>{
  for(const invalid of [response.replace('cpu-thermal','missing'),response+'thermal\tcpu-thermal\ttemp\t1000\n',
    response.replace('53900','bad'),response.replace('53900','200000'),response+'x'.repeat(32768)])
    assert.throws(()=>parseTemperatures(invalid,device.sensors));
});
test('host keys are pinned and the remote command is fixed with no shell interpolation',()=>{
  const args=temperatureSshArgs(device);
  assert.ok(args.includes('StrictHostKeyChecking=yes'));assert.ok(args.includes('BatchMode=yes'));
  assert.ok(args.includes('ClearAllForwardings=yes'));assert.ok(args.includes('ForwardAgent=no'));
  assert.equal(args.at(-1),TEMPERATURE_COMMAND);assert.equal(args.at(-2),'example-temperature@192.0.2.206');
});

test('configuration validates secret paths and stable selectors and separates hosts from the BLE bus',()=>{
  const config=JSON.parse(readFileSync(new URL('../config/gateway.example.json',import.meta.url),'utf8'));
  config.devices.push(device);assert.equal(validateConfig(config).devices.length,2);
  const other={...device,id:'temperature-another',host:'192.0.2.1'};
  assert.equal(collectionGroups([...config.devices,other]).length,3);
  for(const fields of [{host:'-oProxyCommand=x'}, {username:'root; x'}, {identityFile:'/tmp/key\n-oBad'},
    {sensors:[device.sensors[0],device.sensors[0]]},{sensors:[{selector:'thermal:cpu:temp',metric:'fan_rpm'}]}])
    assert.throws(()=>validateConfig({...config,devices:[{...device,...fields}]}));
});
test('real subprocess read, nonzero exit, timeout and cancellation are bounded and reaped',async()=>{
  const result=await readHostTemperature(device,new AbortController().signal,process.execPath,['-e',`process.stdout.write(${JSON.stringify(response)})`]);
  assert.equal(result.metrics.cpu_temperature_c,53.9);assert.equal(result.sampleTimeUtc,undefined);
  await assert.rejects(readHostTemperature(device,new AbortController().signal,process.execPath,['-e','process.stderr.write("secret");process.exit(1)']),/^Error: Temperature SSH read failed$/);
  await assert.rejects(readHostTemperature({...device,timeoutSeconds:0.1},new AbortController().signal,process.execPath,['-e','setInterval(()=>{},1000)']),/timed out/);
  const controller=new AbortController();
  const pending=readHostTemperature(device,controller.signal,process.execPath,['-e','setInterval(()=>{},1000)']);controller.abort();
  await assert.rejects(pending,/Cancelled/);
});
