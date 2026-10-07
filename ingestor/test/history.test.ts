import { historySource } from './history-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { convertHistory } from '../src/history.ts';
test('history UUID and result hash stable across retries, preserves server ingestion time', () => {
  const row = {id:1,owner_id:1,create_time_utc:1669706936947,consumed_energy:45.25};
  const a = convertHistory('electricity_energy',row,historySource,1789809994000);
  const b = convertHistory('electricity_energy',row,historySource,1789809995000);
  assert.equal(a.raw.raw_id,b.raw.raw_id); assert.equal(a.result.hash,b.result.hash);
  assert.equal(a.raw.raw_data_sha256,b.raw.raw_data_sha256);
  assert.equal(a.raw.generate_time_utc,null);
  const value=JSON.parse(a.result.payload);
  assert.equal(value.sample_time_utc,null); assert.equal(value.source_receive_time_utc,new Date(row.create_time_utc).toISOString());
  assert.equal(a.raw.expire_time_utc-a.raw.store_time_utc,180*86400000);
});
test('legacy unit conversion excludes unreliable frequency and apparent power', () => {
  const {raw,result} = convertHistory('electricity_params',{id:1,owner_id:1,create_time_utc:1669706936947,voltage:230,current:2,active_power:0.44,reactive_power:0.01,power_factor:0.95,frequency:0,apparent_power:0},historySource);
  assert.deepEqual(JSON.parse(result.payload).metrics,{voltage_v:230,current_a:2,power_w:440,reactive_power_var:10,power_factor:0.95});
  assert.equal(JSON.parse(raw.raw_data).frequency,0);
});
test('history owner isolation and invalid metric rejection', () => {
  assert.throws(()=>convertHistory('electricity_energy',{id:1,owner_id:2,create_time_utc:1,consumed_energy:1},historySource));
  assert.throws(()=>convertHistory('electricity_energy',{id:1,owner_id:1,create_time_utc:1,consumed_energy:-1},historySource));
});
