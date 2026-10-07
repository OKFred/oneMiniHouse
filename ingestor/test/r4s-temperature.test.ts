import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Queue} from '../src/queue.ts';
import {receive} from '../src/intake.ts';
import {observationTimes} from '../src/message.ts';

test('R4S MQTT identity stays separate; retries deduplicate through raw and both PG queues',()=>{
  const prefix='iot/v1/example-home/example-router',topic=prefix+'/devices/temperature-router/telemetry';
  const sample={schema_version:2,message_id:randomUUID(),site_id:'example-home',gateway_id:'example-router',device_id:'temperature-router',
    sample_time_utc:null,read_time_utc:new Date().toISOString(),observation_kind:'direct_read',quality:'ok',
    metrics:{cpu_temperature_c:46.25,gpu_temperature_c:45.625},source:{driver:'openwrt-temperature-mqtt',interface:'linux_sysfs'}};
  const bytes=Buffer.from(JSON.stringify(sample)),queue=new Queue(':memory:',{maxPending:10,maxRejected:10});
  try {
    assert.equal(receive(queue,topic,bytes,[prefix]),'saved');
    assert.equal(receive(queue,topic,bytes,[prefix]),'duplicate');
    assert.equal(queue.getRaw(sample.message_id)!.raw_data,bytes.toString());
    for (const target of ['local','supabase'] as const) {
      const row=queue.next(target)!;
      assert.equal(row.id,sample.message_id);
      assert.equal(observationTimes(JSON.parse(row.payload)).sample_time_utc,null);
      assert.equal(observationTimes(JSON.parse(row.payload)).time_basis,'collector_read_time');
    }
    assert.equal(receive(queue,topic,Buffer.from(JSON.stringify({...sample,gateway_id:'example-gateway'})),[prefix]),'rejected');
  } finally {queue.close();}
});
