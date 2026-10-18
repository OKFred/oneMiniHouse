import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawArchiveError } from '../src/cloud.ts';
import { deliveryRetryDelay } from '../src/delivery-retry.ts';
import { errorCode,permanentDeliveryError } from '../src/database.ts';
import { Queue } from '../src/queue.ts';
import { parseSample } from '../src/message.ts';

test('quota pause preserves restart recovery and independent PG delivery',()=>{
  const directory=mkdtempSync(join(tmpdir(),'delivery-quota-'));
  const path=join(directory,'queue.sqlite');
  let queue:Queue|undefined;
  try {
    queue=new Queue(path,{maxPending:20,maxRejected:10,rawMirror:true});
    const prefix='iot/v1/example-home/example-gateway';
    const sample={schema_version:1,message_id:randomUUID(),site_id:'example-home',gateway_id:'example-gateway',device_id:'socket-1',captured_at:new Date().toISOString(),quality:'ok',metrics:{energy_kwh:10}};
    const row=parseSample(prefix+'/devices/socket-1/telemetry',Buffer.from(JSON.stringify(sample)),[prefix]);
    queue.accept(row);
    const raw=queue.nextRawBatch(32)[0];
    const error=new RawArchiveError(429,{code:'D1_DAILY_WRITE_LIMIT',retry_after_seconds:7200});
    assert.equal(deliveryRetryDelay('d1',error),3600000);
    assert.equal(permanentDeliveryError(error),false);
    queue.failed('d1',raw.raw_id,errorCode(error),false);
    for(const target of ['local','supabase'] as const){
      assert.equal(deliveryRetryDelay(target,error),250);
      assert.equal(queue.next(target)!.id,row.id);
      queue.done(target,row.id);
    }
    assert.equal(queue.stats().queued,0);
    assert.equal(queue.stats().d1_pending,1);
    assert.equal(queue.stats().delivery_failed,0);
    queue.close();
    queue=new Queue(path,{maxPending:20,maxRejected:10,rawMirror:true});
    assert.equal(queue.stats().d1_pending,1);
    assert.equal(queue.nextRawBatch(32,Date.now()+3600000)[0].raw_id,raw.raw_id);
    assert.equal(queue.getRaw(raw.raw_id)!.raw_data_sha256,raw.raw_data_sha256);
    queue.done('d1',raw.raw_id);
    assert.equal(queue.stats().outstanding_raw,0);
  } finally {queue?.close();rmSync(directory,{recursive:true,force:true});}
});

test('documented limits use bounded target cooldown without classifying generic outages',()=>{
  assert.equal(deliveryRetryDelay('d1',new RawArchiveError(429,{code:'D1_DAILY_READ_LIMIT',retry_after_seconds:45})),45000);
  assert.equal(deliveryRetryDelay('d1',new RawArchiveError(507,{code:'D1_DATABASE_SIZE_LIMIT'})),3600000);
  assert.equal(deliveryRetryDelay('d1',new RawArchiveError(507,{code:'D1_ACCOUNT_STORAGE_LIMIT',retry_after_seconds:999999})),3600000);
  for(const error of [new RawArchiveError(503),new RawArchiveError(429),new RawArchiveError(503,{code:'D1_DAILY_WRITE_LIMIT'}),new Error('upstream timeout')])assert.equal(deliveryRetryDelay('d1',error),250);
});
