import {join} from 'node:path';
import {loadConfig} from '../src/config.ts';
import {Queue,type DeliveryTarget} from '../src/queue.ts';
import {isUuid,PROCESSOR_ID,PROCESSOR_VERSION} from '../src/message.ts';
const [action,id,targetOrProcessor,version]=process.argv.slice(2);
if(!['processing','delivery'].includes(action??'')||!isUuid(id))throw new Error('Usage: node scripts/replay.ts processing RAW_UUID [PROCESSOR_ID] [VERSION] | delivery ARTIFACT_UUID local|supabase|d1|sls');
const config=loadConfig();
const queue=new Queue(join(process.env.DATA_DIR??'/app/data','inbox.sqlite'),{...config.queue,rawMirror:!!config.archive?.rawMirror,frameMirror:!!config.archive?.frames});
try{
  if(action==='processing')queue.replay(id,targetOrProcessor??PROCESSOR_ID,version??PROCESSOR_VERSION);
  else{
    if(!['local','supabase','d1','sls'].includes(targetOrProcessor??''))throw new Error('Unknown delivery target');
    queue.retry(targetOrProcessor as DeliveryTarget,id);
  }
  console.log(JSON.stringify({action,artifact_id:id,scheduled_time_utc:new Date().toISOString(),...queue.stats()}));
}finally{queue.close();}
