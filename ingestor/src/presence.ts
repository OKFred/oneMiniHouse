import { canonical, hash, isUuid, parseJson, stableUuid, utf8, utc, type RawRecord, type RecordRow } from './message.ts';
import { ConflictError,type Processor,type Queue } from './queue.ts';

export const PRESENCE_PROCESSOR_ID = 'device-presence';
export const PRESENCE_PROCESSOR_VERSION = '1';
export const PRESENCE_COVERAGE_LEASE_MS = 90000;
export type PresenceKind = 'direct' | 'proxy' | 'cached';
export type PresenceState = 'online' | 'offline' | 'unknown';
export interface PresenceDevice {
  id: string; label: string; topic: string; siteId: string; gatewayId: string; deviceId: string;
  reporterId: string; kind: PresenceKind; parentId?: string; visible?: boolean; intervalSeconds: number | null; freshnessSeconds: number | null;
}
export interface PresenceConfig { devices: PresenceDevice[]; clients: { clientId: string; topics: string[] }[] }
export interface PresenceWire {
  schema_version: 1; event_id: string; site_id: string; gateway_id: string; device_id: string; reporter_id: string;
  boot_id: string | null; session_id: string; sequence: number | null;
  event: 'online' | 'heartbeat' | 'offline' | 'observation'; online: boolean | null;
  reason: 'connected' | 'heartbeat' | 'shutdown' | 'lwt' | 'read_ok' | 'read_failed' | 'upstream_unknown';
  source_time_utc: string | null; uptime_ms: number | null;
}
export interface PresenceReceipt {
  observerClientId: string; observerSessionId: string; observedAt: number; retained: boolean; qos: number; duplicate: boolean; available: boolean;
  observationOrder?: number;
}
export interface PresenceCursor {
  sessionId: string | null; closedSessions: string[]; sequence: number; sourceTime: number; uptimeMs: number;
  bootId?: string | null; pendingSourceTime?: number;
}
export interface PresenceEvent {
  record_kind: 'device' | 'observer'; event_id: string; physical_device_id: string | null; device_name: string | null;
  kind: PresenceKind | null; parent_id: string | null; site_id: string;
  visible: boolean;
  observer_client_id: string; observer_session_id: string; observed_time_utc: string;
  observation_order: number;
  event: PresenceWire['event'] | 'coverage_start' | 'coverage_heartbeat' | 'coverage_end';
  reporter_id: string | null; boot_id: string | null; session_id: string | null; sequence: number | null;
  source_time_utc: string | null; uptime_ms: number | null; online: boolean | null;
  reason: string; retained: boolean; qos: number; duplicate: boolean; applied: boolean;
  state_after: PresenceState; decision: string; freshness_seconds: number | null;
  valid_until_utc: string | null; coverage_until_utc: string | null;
}
interface FrozenSource {
  processor: typeof PRESENCE_PROCESSOR_ID; device: PresenceDevice; receipt: PresenceReceipt;
  decision?: { applied: boolean; state: PresenceState; reason: string; validUntil: number | null };
}
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const integer = (v: unknown, min = 0) => Number.isSafeInteger(v) && Number(v) >= min;
const stamp = (v: unknown) => typeof v === 'string' && utc(v, Number.MAX_SAFE_INTEGER) && Date.parse(v) >= 0;
function fail(): never { throw new Error('Invalid device presence'); }

export function validatePresenceConfig(value: unknown, existingClientIds: string[], existingTopics: string[]): PresenceConfig {
  if (!object(value) || Object.keys(value).some(k => !['devices', 'clients'].includes(k))
    || !Array.isArray(value.devices) || !value.devices.length || value.devices.length > 256
    || !Array.isArray(value.clients) || !value.clients.length || value.clients.length > 32) fail();
  const ids = new Set<string>(), topics = new Set<string>(), clients = new Set(existingClientIds);
  for (const device of value.devices) {
    if (!object(device) || Object.keys(device).some(k => !['id','label','topic','siteId','gatewayId','deviceId','reporterId','kind','parentId','visible','intervalSeconds','freshnessSeconds'].includes(k))
      || ![device.id,device.siteId,device.gatewayId,device.deviceId,device.reporterId].every(identifier)
      || typeof device.label !== 'string' || !device.label.trim() || device.label.length > 100 || /[\x00-\x1f]/.test(device.label)
      || Buffer.from(device.label,'utf8').toString('utf8')!==device.label
      || typeof device.topic !== 'string' || !device.topic.length || device.topic.length > 512
      || /[+#\x00-\x20]/.test(device.topic) || existingTopics.some(filter=>{
        const parts=filter.split('/'),actual=(device.topic as string).split('/');
        return parts.length===actual.length&&parts.every((part,index)=>part==='+'||part===actual[index]);
      }) || topics.has(device.topic) || ids.has(String(device.id))
      || typeof device.kind!=='string' || !['direct','proxy','cached'].includes(device.kind)
      || (device.kind==='direct'?(device.intervalSeconds!==60||device.freshnessSeconds!==300)
        :device.kind==='cached'&&device.intervalSeconds===null&&device.freshnessSeconds===null?false
        :!integer(device.intervalSeconds,1)||Number(device.intervalSeconds)>86400||device.freshnessSeconds!==Math.max(300,3*Number(device.intervalSeconds)))
      || (device.visible!==undefined&&typeof device.visible!=='boolean')
      || (device.parentId !== undefined && (!identifier(device.parentId) || device.parentId === device.id))) fail();
    ids.add(String(device.id)); topics.add(device.topic);
  }
  const devices = value.devices as unknown as PresenceDevice[];
  for (const device of devices) {
    const visited = new Set([device.id]); let parent = device.parentId;
    while (parent) { if (visited.has(parent) || !ids.has(parent)) fail(); visited.add(parent); parent = devices.find(d => d.id === parent)!.parentId; }
    if (device.kind !== 'direct' && !device.parentId) fail();
  }
  const assigned = new Set<string>();
  for (const client of value.clients) {
    if (!object(client) || Object.keys(client).some(k => !['clientId','topics'].includes(k)) || !identifier(client.clientId) || clients.has(client.clientId)
      || !Array.isArray(client.topics) || !client.topics.length || client.topics.length > 10) fail();
    clients.add(client.clientId);
    for (const topic of client.topics) { if (typeof topic !== 'string' || !topics.has(topic) || assigned.has(topic)) fail(); assigned.add(topic); }
  }
  if (assigned.size !== topics.size || devices.some(d => clients.has(d.reporterId))) fail();
  for(const device of devices){
    const client=(value.clients as PresenceConfig['clients']).find(c=>c.topics.includes(device.topic))!;
    const frozen={processor:PRESENCE_PROCESSOR_ID,device,receipt:{observerClientId:client.clientId,observerSessionId:'00000000-0000-4000-8000-000000000000',
      observedAt:Number.MAX_SAFE_INTEGER,observationOrder:Number.MAX_SAFE_INTEGER,retained:false,qos:1,duplicate:false,available:true},
      decision:{applied:true,state:'unknown',reason:'unobserved_reporter_session',validUntil:Number.MAX_SAFE_INTEGER}};
    if(Buffer.byteLength(canonical(frozen))>2048)throw new Error('Presence frozen mapping exceeds archive metadata limit');
  }
  return value as unknown as PresenceConfig;
}

// Presence and its compatibility fields have bounded depth; duplicate keys must not replace an identity.
function strictJson(text: string): unknown {
  let at = 0, nodes = 0;
  const space = () => { while (/\s/.test(text[at] ?? '') && at < text.length) at++; };
  const string = () => { const start = at++; while (at < text.length) { if (text[at] === '\\') at += 2; else if (text[at++] === '"') return JSON.parse(text.slice(start,at)) as string; } return fail(); };
  const walk = (depth: number): void => {
    if (depth > 8 || ++nodes > 1024) fail(); space();
    if (text[at] === '{') {
      const keys = new Set<string>(); at++; space(); if (text[at] === '}') { at++; return; }
      for (;;) { space(); const key = string(); if (keys.has(key)) fail(); keys.add(key); space(); if (text[at++] !== ':') fail(); walk(depth+1); space(); if (text[at] === '}') { at++; return; } if (text[at++] !== ',') fail(); }
    }
    if (text[at] === '[') { at++; space(); if (text[at] === ']') { at++; return; } for (;;) { walk(depth+1); space(); if (text[at] === ']') { at++; return; } if (text[at++] !== ',') fail(); } }
    if (text[at] === '"') { string(); return; }
    const start = at; while (at < text.length && !/[\s,}\]]/.test(text[at])) at++; if (at === start) fail();
  };
  const value = parseJson(text); walk(0); space(); if (at !== text.length) fail(); return value;
}

export function decodePresence(device: PresenceDevice, bytes: Buffer): PresenceWire {
  if (bytes.length > 16384) fail(); const value = strictJson(utf8(bytes));
  const required = ['schema_version','event_id','site_id','gateway_id','device_id','reporter_id','boot_id','session_id','sequence','event','online','reason','source_time_utc','uptime_ms'];
  const legacy = ['quality','read_time_utc','captured_at','devices','mqtt_connected','queued','pending','dropped','frames','message_id',
    'protocolVersion','deviceId','status','timestamp'];
  if (!object(value) || required.some(k => !Object.hasOwn(value,k)) || Object.keys(value).some(k => !required.includes(k) && !legacy.includes(k))
    || value.schema_version !== 1 || !isUuid(value.event_id) || !isUuid(value.session_id)
    || value.site_id !== device.siteId || value.gateway_id !== device.gatewayId || value.device_id !== device.deviceId || value.reporter_id !== device.reporterId
    || (value.boot_id !== null && (typeof value.boot_id !== 'string' || !value.boot_id.length || value.boot_id.length > 128 || /[\x00-\x1f]/.test(value.boot_id)
      || Buffer.from(value.boot_id,'utf8').toString('utf8')!==value.boot_id))
    || (value.sequence !== null && !integer(value.sequence)) || (value.uptime_ms !== null && !integer(value.uptime_ms))
    || typeof value.reason!=='string' || (value.source_time_utc !== null && !stamp(value.source_time_utc))) fail();
  const valid = value.event === 'online' && value.online === true && value.reason === 'connected'
    || value.event === 'heartbeat' && value.online === true && value.reason === 'heartbeat'
    || value.event === 'offline' && value.online === false && ['shutdown','lwt'].includes(String(value.reason))
    || value.event === 'observation' && (value.online === true && value.reason === 'read_ok' || value.online === false && value.reason === 'read_failed' || value.online === null && value.reason === 'upstream_unknown');
  if (!valid || (device.kind === 'direct') === (value.event === 'observation')) fail();
  if (value.reason === 'lwt' ? value.sequence !== null || value.source_time_utc !== null || value.uptime_ms !== null
    : value.sequence === null || value.uptime_ms === null) fail();
  if (value.quality !== undefined && (typeof value.quality!=='string'||!['ok','degraded','offline'].includes(value.quality))) fail();
  for (const key of ['read_time_utc','captured_at']) if (value[key] !== undefined && value[key] !== null && !stamp(value[key])) fail();
  for (const key of ['queued','pending','dropped']) if (value[key] !== undefined && !integer(value[key])) fail();
  if (value.mqtt_connected !== undefined && typeof value.mqtt_connected !== 'boolean') fail();
  if (value.message_id !== undefined && value.message_id !== value.event_id) fail();
  for (const key of ['protocolVersion','timestamp']) if (value[key] !== undefined && !integer(value[key])) fail();
  if (value.deviceId !== undefined && !identifier(value.deviceId)) fail();
  if (value.status !== undefined && (typeof value.status!=='string'||!['ONLINE','OFFLINE'].includes(value.status))) fail();
  if (value.devices !== undefined && (!object(value.devices) || Object.keys(value.devices).length > 128
    || Object.entries(value.devices).some(([key,state]) => !identifier(key) || typeof state!=='string'||!['pending','ok','error'].includes(state)))) fail();
  if (value.frames !== undefined && (!object(value.frames) || Object.keys(value.frames).length !== 3
    || ['archived','pending','dropped_pending'].some(k => !integer((value.frames as Record<string,unknown>)[k])))) fail();
  return {...value,event_id:String(value.event_id).toLowerCase(),session_id:String(value.session_id).toLowerCase()} as unknown as PresenceWire;
}

export function presenceRaw(device: PresenceDevice, bytes: Buffer, receipt: PresenceReceipt, retentionDays = 180): RawRecord {
  const wire = decodePresence(device,bytes);
  if (!identifier(receipt.observerClientId) || !isUuid(receipt.observerSessionId) || !integer(receipt.observedAt)
    || typeof receipt.retained !== 'boolean' || typeof receipt.duplicate !== 'boolean' || typeof receipt.available !== 'boolean' || receipt.qos !== 1
    || !integer(retentionDays,1) || retentionDays > 3650) fail();
  const source: FrozenSource = { processor: PRESENCE_PROCESSOR_ID, device, receipt };
  return { raw_id: stableUuid(`${PRESENCE_PROCESSOR_ID}\n${device.topic}\n${wire.event_id}`), topic: device.topic,
    source_kind: 'mqtt_presence', source_id: canonical(source), source_message_id: wire.event_id,
    source_site_id: device.siteId, source_gateway_id: device.gatewayId, source_device_id: device.deviceId,
    data_kind: 'inline', content_type: 'application/json', raw_data: utf8(bytes), raw_data_sha256: hash(bytes),
    generate_time_utc: wire.source_time_utc === null ? null : Date.parse(wire.source_time_utc),
    receive_time_utc: receipt.observedAt, store_time_utc: receipt.observedAt, expire_time_utc: receipt.observedAt + retentionDays*86400000 };
}

export function decidePresence(wire: PresenceWire, device: PresenceDevice, receipt: PresenceReceipt, previous?: PresenceCursor) {
  const cursor: PresenceCursor = previous ? { ...previous, closedSessions: [...previous.closedSessions] }
    : { sessionId: null, closedSessions: [], sequence: -1, sourceTime: -1, uptimeMs: -1 };
  const ignore = (reason: string) => ({ cursor, decision: { applied: false, state: 'unknown' as PresenceState, reason, validUntil: null } });
  if (receipt.retained) return ignore('retained_snapshot');
  if (!receipt.available) return ignore('observer_unavailable');
  const source = wire.source_time_utc === null ? null : Date.parse(wire.source_time_utc);
  if (source !== null && source > receipt.observedAt+500) return ignore('future_source_time');
  if (wire.event !== 'offline' || wire.reason !== 'lwt') {
    if (source === null) return ignore('source_clock_unknown');
    if (device.freshnessSeconds!==null&&receipt.observedAt-source > device.freshnessSeconds*1000) return ignore('delayed_source_event');
  }
  if (cursor.closedSessions.includes(wire.session_id)) return ignore('closed_reporter_session');
  if (wire.session_id !== cursor.sessionId) {
    if (wire.event === 'offline' || device.kind === 'direct' && wire.event !== 'online') return ignore('unobserved_reporter_session');
    if (source === null || source < cursor.sourceTime || device.kind !== 'direct' && source === cursor.sourceTime) return ignore('older_reporter_session');
    const sameRuntimeAdvanced = wire.boot_id !== null && wire.boot_id === cursor.bootId && wire.uptime_ms !== null && wire.uptime_ms > cursor.uptimeMs;
    const oldSessionClosed = cursor.sessionId !== null && cursor.closedSessions.includes(cursor.sessionId);
    // Coarse device clocks can give a reconnect birth the same second as its predecessor.
    // Keep an ambiguous birth unknown until this new session provides a later live timestamp.
    cursor.pendingSourceTime = source === cursor.sourceTime && !sameRuntimeAdvanced && !oldSessionClosed ? source : undefined;
    if (cursor.sessionId) cursor.closedSessions = [...cursor.closedSessions,cursor.sessionId].slice(-64);
    cursor.sessionId = wire.session_id; cursor.sequence = -1; cursor.uptimeMs = -1; cursor.bootId = wire.boot_id;
  }
  if (wire.sequence !== null && wire.sequence <= cursor.sequence) return ignore('old_sequence');
  if (source !== null && source < cursor.sourceTime || wire.uptime_ms !== null && wire.uptime_ms < cursor.uptimeMs) return ignore('regressed_reporter_clock');
  if (wire.sequence !== null) cursor.sequence = wire.sequence;
  if (wire.uptime_ms !== null) cursor.uptimeMs = wire.uptime_ms;
  if (source !== null) cursor.sourceTime = source;
  if (wire.event === 'offline') cursor.closedSessions = [...cursor.closedSessions,wire.session_id].slice(-64);
  if (cursor.pendingSourceTime !== undefined) {
    if (wire.event !== 'offline' && source !== null && source <= cursor.pendingSourceTime) {
      return { cursor, decision: { applied: true, state: 'unknown' as PresenceState, reason: 'pending_reporter_session', validUntil: null } };
    }
    delete cursor.pendingSourceTime;
  }
  const state: PresenceState = device.kind === 'cached' || wire.online === null ? 'unknown' : wire.online ? 'online' : 'offline';
  return { cursor, decision: { applied: true, state, reason: device.kind === 'cached' ? 'cached_observation' : wire.reason,
    validUntil: state === 'online' ? Math.min(receipt.observedAt,source!)+device.freshnessSeconds!*1000 : null } };
}

/** Called only inside Queue's durable intake transaction, before PUBACK. */
export function freezePresence(raw: RawRecord, previous: PresenceCursor|undefined, order: number) {
  const source = parseJson(raw.source_id) as FrozenSource;
  if (source.processor !== PRESENCE_PROCESSOR_ID || source.device.topic !== raw.topic || source.receipt.observedAt !== raw.receive_time_utc) fail();
  if(!integer(order,1))fail();source.receipt={...source.receipt,observationOrder:order};
  const outcome = decidePresence(decodePresence(source.device,Buffer.from(raw.raw_data)),source.device,source.receipt,previous);
  const frozen = { ...raw, source_id: canonical({ ...source, decision: outcome.decision }) };
  if (Buffer.byteLength(frozen.source_id) > 2048) fail();
  return { raw: frozen, cursor: outcome.cursor, deviceId: source.device.id };
}

export function isPresenceRow(row: RecordRow): boolean {
  return [PRESENCE_PROCESSOR_ID,PRESENCE_OBSERVER_PROCESSOR_ID].includes(row.processor_id ?? '') && row.processor_version === '1' && row.output_key === 'presence';
}
export function presenceEvent(row: RecordRow): PresenceEvent {
  if (!isPresenceRow(row)) fail();
  const value = parseJson(row.payload) as PresenceEvent;
  if (!value || !['device','observer'].includes(value.record_kind) || hash(row.payload) !== row.hash || !isUuid(value.event_id)
    || !stamp(value.observed_time_utc) || !integer(value.observation_order,1) || !identifier(value.observer_client_id) || !isUuid(value.observer_session_id)) fail();
  return value;
}
export const presenceProcessor: Processor = {
  id: PRESENCE_PROCESSOR_ID, version: PRESENCE_PROCESSOR_VERSION,
  process(raw) {
    if (hash(raw.raw_data) !== raw.raw_data_sha256) fail();
    const source = parseJson(raw.source_id) as FrozenSource;
    if (source.processor !== PRESENCE_PROCESSOR_ID || !source.decision || source.receipt.observedAt !== raw.receive_time_utc
      || !integer(source.receipt.observationOrder,1) || raw.source_kind!=='mqtt_presence'
      || raw.source_site_id!==source.device.siteId || raw.source_gateway_id!==source.device.gatewayId || raw.source_device_id!==source.device.deviceId) fail();
    const wire = decodePresence(source.device,Buffer.from(raw.raw_data));
    if (raw.topic !== source.device.topic || raw.source_message_id !== wire.event_id || raw.raw_id !== stableUuid(`${PRESENCE_PROCESSOR_ID}\n${raw.topic}\n${wire.event_id}`)) fail();
    const { device, receipt, decision } = source;
    const event: PresenceEvent = { record_kind: 'device', event_id: wire.event_id, physical_device_id: device.id, device_name: device.label,
      kind: device.kind, parent_id: device.parentId ?? null, site_id: device.siteId,visible:device.visible!==false,
      observer_client_id: receipt.observerClientId, observer_session_id: receipt.observerSessionId, observed_time_utc: new Date(raw.receive_time_utc).toISOString(),
      observation_order:receipt.observationOrder!,
      event: wire.event, reporter_id: wire.reporter_id, boot_id: wire.boot_id, session_id: wire.session_id, sequence: wire.sequence,
      source_time_utc: wire.source_time_utc, uptime_ms: wire.uptime_ms, online: wire.online, reason: wire.reason,
      retained: receipt.retained, qos: receipt.qos, duplicate: receipt.duplicate, applied: decision.applied, state_after: decision.state,
      decision: decision.reason, freshness_seconds: device.freshnessSeconds,
      valid_until_utc: decision.validUntil === null ? null : new Date(decision.validUntil).toISOString(), coverage_until_utc: null };
    return presenceRow(raw,event);
  },
};
function presenceRow(raw: RawRecord, event: PresenceEvent): RecordRow {
  const payload = canonical(event);
  const processor=event.record_kind==='observer'?PRESENCE_OBSERVER_PROCESSOR_ID:PRESENCE_PROCESSOR_ID;
  return { id: stableUuid(`${raw.raw_id}\n${processor}\n1\npresence`), topic: raw.topic, payload, hash: hash(payload),
    raw_id:raw.raw_id,processor_id:processor,processor_version:'1',received_at: new Date(raw.receive_time_utc).toISOString(), output_key: 'presence' };
}

export const PRESENCE_OBSERVER_PROCESSOR_ID = 'presence-observer';
export function observerRaw(siteId: string, clientId: string, sessionId: string, sequence: number,
  event: 'coverage_start'|'coverage_heartbeat'|'coverage_end', now = Date.now(), retentionDays = 180): RawRecord {
  if (!identifier(siteId) || !identifier(clientId) || !isUuid(sessionId) || !integer(sequence) || !integer(now)) fail();
  const id = stableUuid(`${PRESENCE_OBSERVER_PROCESSOR_ID}\n${siteId}\n${clientId}\n${sessionId}\n${sequence}`);
  const value: PresenceEvent = { record_kind: 'observer', event_id: id, physical_device_id: null, device_name: null, kind: null, parent_id: null, site_id: siteId,visible:false,
    observer_client_id: clientId, observer_session_id: sessionId, observed_time_utc: new Date(now).toISOString(), event,
    observation_order:0,
    reporter_id: null, boot_id: null, session_id: null, sequence, source_time_utc: null, uptime_ms: null, online: null,
    reason: event, retained: false, qos: 1, duplicate: false, applied: true, state_after: 'unknown', decision: event, freshness_seconds: null,
    valid_until_utc: null, coverage_until_utc: new Date(event === 'coverage_end' ? now : now+PRESENCE_COVERAGE_LEASE_MS).toISOString() };
  const payload = canonical(value);
  return { raw_id: id, topic: `iot/v1/${siteId}/_presence-observer/${clientId}`, source_kind: 'presence_observer', source_id: PRESENCE_OBSERVER_PROCESSOR_ID,
    source_message_id: id, source_site_id: siteId, source_gateway_id: null, source_device_id: null,
    data_kind: 'inline', content_type: 'application/json', raw_data: payload, raw_data_sha256: hash(payload),
    generate_time_utc: now, receive_time_utc: now, store_time_utc: now, expire_time_utc: now+retentionDays*86400000 };
}
export const presenceObserverProcessor: Processor = {
  id: PRESENCE_OBSERVER_PROCESSOR_ID, version: '1',
  process(raw) {
    const event = parseJson(raw.raw_data) as PresenceEvent;
    const expected = observerRaw(event.site_id,event.observer_client_id,event.observer_session_id,event.sequence!,event.event as 'coverage_start',raw.receive_time_utc);
    const source=parseJson(raw.source_id) as {processor:string;order:number};
    if (!['coverage_start','coverage_heartbeat','coverage_end'].includes(event.event) || raw.source_kind!=='presence_observer'
      || source.processor !== PRESENCE_OBSERVER_PROCESSOR_ID || !integer(source.order,1)
      || raw.raw_id !== expected.raw_id || raw.raw_data_sha256 !== hash(raw.raw_data) || canonical(event) !== expected.raw_data) fail();
    return presenceRow(raw,{...event,observation_order:source.order});
  },
};

export function receivePresence(queue: Queue, device: PresenceDevice, bytes: Buffer, receipt: PresenceReceipt): 'saved'|'duplicate'|'rejected' {
  let raw: RawRecord;
  try { raw = presenceRaw(device,bytes,receipt,queue.options.rawRetentionDays); }
  catch { queue.reject(device.topic,bytes,'INVALID_DEVICE_PRESENCE',{sourceKind:'mqtt_presence',siteId:device.siteId}); return 'rejected'; }
  try{return queue.acceptPresence(raw);}catch(error){
    if(!(error instanceof ConflictError))throw error;
    queue.reject(device.topic,bytes,'PRESENCE_EVENT_ID_CONFLICT',{sourceKind:'mqtt_presence',siteId:device.siteId});return 'rejected';
  }
}

/** Pure reference for current-state consumers. SQL readers use the same frozen decisions plus coverage leases. */
export function presenceAt(devices: PresenceDevice[], events: PresenceEvent[], at: number): Record<string,PresenceState> {
  const ordered = events.filter(e => Date.parse(e.observed_time_utc) <= at).sort((a,b) => Date.parse(a.observed_time_utc)-Date.parse(b.observed_time_utc)
    || a.observation_order-b.observation_order);
  const latest = new Map<string,PresenceEvent>(), coverage = new Map<string,PresenceEvent>();
  for (const event of ordered) {
    if (event.record_kind === 'observer') coverage.set(event.observer_client_id,event);
    else if (event.applied && event.physical_device_id) latest.set(event.physical_device_id,event);
  }
  const states: Record<string,PresenceState> = Object.create(null);
  const state = (device: PresenceDevice): PresenceState => {
    if (states[device.id]) return states[device.id];
    const event = latest.get(device.id), seen = event && coverage.get(event.observer_client_id),parent=device.parentId?latest.get(device.parentId):undefined;
    if (!event || !seen || seen.event === 'coverage_end' || seen.observer_session_id !== event.observer_session_id
      || Date.parse(seen.coverage_until_utc!) <= at || (device.parentId && (state(devices.find(d => d.id === device.parentId)!) !== 'online'
        || parent?.reporter_id===event.reporter_id&&parent.session_id!==event.session_id))) return states[device.id] = 'unknown';
    return states[device.id] = event.state_after === 'online' && Date.parse(event.valid_until_utc!) <= at ? 'offline' : event.state_after;
  };
  for (const device of devices) state(device);
  return Object.fromEntries(devices.filter(device=>device.visible!==false).map(device=>[device.id,states[device.id]]));
}
