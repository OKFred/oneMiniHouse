import { createRequire } from 'node:module';
import { createHash,createHmac } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { secret } from './config.ts';
import type { RawRecord, FrameRecord } from './message.ts';

export interface CloudRawConfig { url: string; tokenFile: string; timeoutMs?: number }
export interface FrameSinkConfig { endpoint: string; project: string; logstore: string; accessKeyIdFile: string; accessKeySecretFile: string; securityTokenFile?: string; timeoutMs?: number }
export interface CloudRawSink { write(raw: RawRecord): Promise<void>; writeBatch(raw: RawRecord[]): Promise<void> }
export interface FrameSink { write(frame: FrameRecord): Promise<void> }
export class RawArchiveError extends Error {
  code: string;
  constructor(status: number) {
    super(`Raw archive HTTP ${status}`);
    this.code=status===400?'RAW_INVALID':status===409?'RAW_CONFLICT':status===413?'RAW_TOO_LARGE':`RAW_HTTP_${status}`;
  }
}

export function createCloudRawSink(config?: CloudRawConfig): CloudRawSink | undefined {
  if (!config) return undefined;
  const url = new URL(config.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw new Error('Raw archive endpoint must be credential-free HTTPS');
  const token = secret(config.tokenFile);
  const writeChunk = async (records: RawRecord[]) => {
    if (!records.length) return;
    if (records.length > 32) throw new Error('Raw archive batches are limited to 32 records');
    const response = await fetch(url, { method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ schema_version: 1, records }), signal: AbortSignal.timeout(config.timeoutMs ?? 15000) });
    if (!response.ok) { await response.body?.cancel(); throw new RawArchiveError(response.status); }
    // A transport success alone is not a durable-delivery acknowledgment.
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Raw archive acknowledgment missing');
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > 16384) { await reader.cancel(); throw new Error('Raw archive acknowledgment exceeds limit'); }
      chunks.push(part.value);
    }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { accepted?: { raw_id: string; raw_data_sha256: string }[] };
    if (!Array.isArray(result.accepted) || result.accepted.length !== records.length || records.some(r => !result.accepted!.some(a => a.raw_id === r.raw_id && a.raw_data_sha256 === r.raw_data_sha256))) throw new Error('Raw archive acknowledgment mismatch');
  };
  const writeBatch = async (records: RawRecord[]) => {
    let chunk: RawRecord[] = [];
    for (const record of records) {
      const candidate = [...chunk, record];
      if (candidate.length > 32 || Buffer.byteLength(JSON.stringify({ schema_version: 1, records: candidate })) > 1024 * 1024) {
        if (!chunk.length) throw new Error('Raw archive record exceeds request limit');
        await writeChunk(chunk); chunk = [record];
      } else chunk = candidate;
    }
    if (chunk.length) await writeChunk(chunk);
  };
  return { write: raw => writeBatch([raw]), writeBatch };
}

// SLS documented protobuf wire schema and HMAC-SHA1 HTTP API. Using fetch
// keeps HTTP status and timeouts observable; the older Node SDK discards status.
// https://www.alibabacloud.com/help/en/sls/developer-reference/data-encoding
// https://www.alibabacloud.com/help/en/sls/developer-reference/request-signatures
export function slsLogGroup(content: Record<string,string>, timestamp: number): Buffer {
  const protobuf=createRequire(import.meta.url)('protobufjs') as typeof import('protobufjs');
  const root=protobuf.Root.fromJSON({nested:{
    Content:{fields:{Key:{type:'string',id:1},Value:{type:'string',id:2}}},
    Log:{fields:{Time:{type:'uint32',id:1},Contents:{rule:'repeated',type:'Content',id:2}}},
    LogGroup:{fields:{Logs:{rule:'repeated',type:'Log',id:1},Topic:{type:'string',id:3},Source:{type:'string',id:4}}}
  }});
  const type=root.lookupType('LogGroup');
  return Buffer.from(type.encode({Logs:[{Time:timestamp,Contents:Object.entries(content).map(([Key,Value])=>({Key,Value}))}],Topic:'iot_protocol_frames',Source:'oneMiniHouse'}).finish());
}
export function slsSignedHeaders(path: string, body: Buffer, rawSize: number, credentials:{id:string;secret:string;token?:string}, date = new Date().toUTCString()): Record<string,string> {
  const headers:Record<string,string>={'content-type':'application/x-protobuf','content-md5':createHash('md5').update(body).digest('hex').toUpperCase(),date,'x-log-apiversion':'0.6.0','x-log-bodyrawsize':String(rawSize),'x-log-compresstype':'gzip','x-log-signaturemethod':'hmac-sha1'};
  if(credentials.token)headers['x-acs-security-token']=credentials.token;
  const canonicalHeaders=Object.keys(headers).filter(k=>k.startsWith('x-log-')||k.startsWith('x-acs-')).sort().map(k=>`${k}:${headers[k].trim()}\n`).join('');
  const signing=`POST\n${headers['content-md5']}\n${headers['content-type']}\n${date}\n${canonicalHeaders}${path}`;
  headers.authorization=`LOG ${credentials.id}:${createHmac('sha1',credentials.secret).update(signing).digest('base64')}`;
  return headers;
}

export function createFrameSink(config?: FrameSinkConfig): FrameSink | undefined {
  if (!config) return undefined;
  if (!/^[a-z0-9-]+\.log\.aliyuncs\.com$/.test(config.endpoint)) throw new Error('SLS endpoint must be an Alibaba region endpoint without a scheme');
  if (!/^[a-z][a-z0-9-]{1,61}[a-z0-9]$/.test(config.project) || !/^[a-z][a-z0-9_-]{1,61}[a-z0-9]$/.test(config.logstore)) throw new Error('Invalid SLS project or logstore');
  const credentials={id:secret(config.accessKeyIdFile),secret:secret(config.accessKeySecretFile),...(config.securityTokenFile?{token:secret(config.securityTokenFile)}:{})};
  const path=`/logstores/${config.logstore}/shards/lb`;
  return { async write(frame) {
    const content: Record<string, string> = { frame_id: frame.frame_id, collection_id: frame.collection_id, topic: frame.topic, raw_data: frame.raw_data, raw_data_sha256: frame.raw_data_sha256, frame_time_utc: String(frame.frame_time_utc), receive_time_utc: String(frame.receive_time_utc), store_time_utc: String(frame.store_time_utc) };
    // Use upload time for the SLS log clock: its accepted time window is narrower
    // than a prolonged outage. The original frame timestamp stays in content.
    const raw=slsLogGroup(content,Math.floor(Date.now()/1000)),body=gzipSync(raw);
    const response=await fetch(`https://${config.project}.${config.endpoint}${path}`,{method:'POST',redirect:'error',headers:slsSignedHeaders(path,body,raw.length,credentials),body,signal:AbortSignal.timeout(config.timeoutMs??15000)});
    await response.body?.cancel();
    if(response.status!==200)throw new Error(`SLS HTTP ${response.status}`);
  } };
}
