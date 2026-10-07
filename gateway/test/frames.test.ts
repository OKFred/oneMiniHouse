import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FrameStore, frameEnvelope, FrameStorageError } from '../src/frames.ts';
const make = () => frameEnvelope({site_id:'example-home',gateway_id:'test',device_id:'meter',collection_id:'d1bd2c82-8f62-4479-9a5b-659af80702a6'}, {direction:'rx',protocol:'modbus-rtu',frame_time_utc:new Date().toISOString(),wire_hex:'58030400',crc_valid:false});
test('protocol archive survives PUBACK and restart; failed PUBACK reuses the same frame ID',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'frames-')); let store=new FrameStore(join(dir,'f.sqlite'));
  try {
    const f=make();store.save('test/frames',f);store.close();store=new FrameStore(join(dir,'f.sqlite'));
    await assert.rejects(store.flush(async()=>{throw new Error('lost ACK');}));
    assert.equal(store.next()!.frame_id,f.frame_id);
    await store.flush(async(_t,p,retain)=>{assert.equal(retain,false);assert.equal(JSON.parse(p).collection_id,f.collection_id);});
    assert.deepEqual(store.stats(),{archived:1,pending:0,dropped_pending:0});
    assert.equal(store.prune(Date.now()+31*86400000),1);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('protocol retention is bounded independently and accounts for dropped pending frames',()=>{
  const store=new FrameStore(':memory:',{maxAgeDays:30,maxRows:2});
  try{
    const old=make();store.save('f',old,0);store.save('f',make(),Date.now());
    assert.equal(store.stats().dropped_pending,1);
    const a=make();store.save('f',a);store.save('f',make());
    assert.deepEqual(store.stats(),{archived:2,pending:2,dropped_pending:2});
    assert.throws(()=>store.save('f',{...make(),wire_hex:'aa'.repeat(513)}),FrameStorageError);
  }finally{store.close();}
});
