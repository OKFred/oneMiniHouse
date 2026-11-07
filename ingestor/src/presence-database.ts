import type pg from 'pg';
import { canonical,hash,type RecordRow } from './message.ts';
import { ConflictError } from './queue.ts';
import { presenceEvent,type PresenceEvent } from './presence.ts';

export const presenceColumns = ['record_kind','event_id','physical_device_id','device_name','kind','parent_id','site_id','visible',
  'observer_client_id','observer_session_id','observed_time_utc','observation_order','event','reporter_id','boot_id','session_id','sequence',
  'source_time_utc','uptime_ms','online','reason','retained','qos','duplicate','applied','state_after','decision',
  'freshness_seconds','valid_until_utc','coverage_until_utc'] as const satisfies readonly (keyof PresenceEvent)[];
const columns = ['result_id','raw_id','processor_id',...presenceColumns,'payload_sha256','result_sha256'];
export function presenceValues(row:RecordRow):unknown[] {
  const event=presenceEvent(row);
  const resultHash=hash(canonical({result_id:row.id,raw_id:row.raw_id,processor_id:row.processor_id,version:'1',event}));
  return [row.id,row.raw_id,row.processor_id,...presenceColumns.map(column=>event[column]),row.hash,resultHash];
}
/** Confirm every projected field after INSERT, including a previous commit whose reply was lost. */
export async function writePresenceBatch(pool:Pick<pg.Pool,'query'>,rows:RecordRow[]):Promise<string[]> {
  if(!rows.length)return [];
  const values:unknown[]=[],expected=new Map<string,unknown[]>();
  const tuples=rows.map(row=>{
    const start=values.length,record=presenceValues(row);expected.set(row.id,record);values.push(...record);
    return '('+columns.map((_,index)=>'$'+(start+index+1)).join(',')+')';
  });
  await pool.query(`INSERT INTO iot.device_presence_events (${columns.join(',')}) VALUES ${tuples.join(',')} ON CONFLICT(result_id) DO NOTHING`,values);
  const persisted=await pool.query(`SELECT ${columns.join(',')} FROM iot.device_presence_events WHERE result_id=ANY($1::uuid[])`,[rows.map(row=>row.id)]);
  if(persisted.rows.length!==expected.size)throw new ConflictError('Presence batch missing committed IDs');
  for(const record of persisted.rows){
    const wanted=expected.get(record.result_id);if(!wanted)throw new ConflictError('Unexpected presence result');
    if(columns.some((column,index)=>{
      const value=record[column] instanceof Date?record[column].toISOString():typeof wanted[index]==='number'&&typeof record[column]==='string'?Number(record[column]):record[column];
      return value!==wanted[index];
    }))throw new ConflictError('Presence result ID hash or projection conflict');
  }
  return rows.map(row=>row.id);
}
