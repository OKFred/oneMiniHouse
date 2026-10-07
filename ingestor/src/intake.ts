import type { Queue } from './queue.ts';
import { ConflictError } from './queue.ts';
import { parseSample, parseFrame } from './message.ts';
import { collectdRaw, COLLECTD_PROCESSOR_ID, COLLECTD_PROCESSOR_VERSION, type CollectdTemperatureInput } from './collectd.ts';
export function receive(queue: Queue, topic: string, bytes: Buffer, prefixes: string[], collectd: CollectdTemperatureInput[] = []): 'saved' | 'duplicate' | 'rejected' {
  const input=collectd.find(v=>v.topic===topic);
  if(input){
    let raw;
    try{raw=collectdRaw(input,bytes,Date.now(),queue.options.rawRetentionDays);}
    catch{queue.reject(topic,bytes,'INVALID_COLLECTD_TEMPERATURE');return 'rejected';}
    try{return queue.acceptRaw(raw,COLLECTD_PROCESSOR_ID,COLLECTD_PROCESSOR_VERSION);}
    catch(e){if(!(e instanceof ConflictError))throw e;queue.reject(topic,bytes,'COLLECTD_OBSERVATION_CONFLICT');return 'rejected';}
  }
  if(topic.endsWith('/frames')) {
    let frame;
    try {frame=parseFrame(topic,bytes,prefixes,Date.now(),queue.options.frameRetentionDays);}
    catch {queue.reject(topic,bytes,'INVALID_FRAME');return 'rejected';}
    try {return queue.acceptFrame(frame);}
    catch(e) {if(!(e instanceof ConflictError))throw e;queue.reject(topic,bytes,'FRAME_ID_CONFLICT');return 'rejected';}
  }
  let row;
  try {row=parseSample(topic,bytes,prefixes);}
  catch {queue.reject(topic,bytes,'INVALID_TELEMETRY');return 'rejected';}
  try {return queue.accept(row);}
  catch(e) {if(!(e instanceof ConflictError))throw e;queue.reject(topic,bytes,'MESSAGE_ID_CONFLICT');return 'rejected';}
}
