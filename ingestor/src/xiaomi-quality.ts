import { assessMetricQuality } from './metric-quality.ts';
import { parseJson, parseSample, type RawRecord, type RecordRow, type Sample } from './message.ts';

export const XIAOMI_QUALITY_PROCESSOR_ID = 'xiaomi-temperature-quality';
export const XIAOMI_QUALITY_PROCESSOR_VERSION = '1';
export function isXiaomiTemperature(sample: Sample): boolean {
  return sample.source?.driver === 'xiaomi-gateway-v3-temperature'
    && sample.source?.sensor_model === 'WSDCGQ01LM';
}
export const xiaomiQualityProcessor = {
  id: XIAOMI_QUALITY_PROCESSOR_ID, version: XIAOMI_QUALITY_PROCESSOR_VERSION,
  process(raw: RawRecord): RecordRow {
    const prefix = raw.topic.split('/').slice(0, 4).join('/');
    const row = parseSample(raw.topic, Buffer.from(raw.raw_data), [prefix], new Date(Math.max(Date.now(), raw.receive_time_utc)));
    const assessment = assessMetricQuality(parseJson(row.payload) as Sample);
    if (!assessment) throw new Error('Unsupported Xiaomi quality source');
    // 原始信封、读数、来源 quality 不变；指标可信度单独版本化，供查询层逐指标过滤。
    row.lineage = { ...row.lineage, metric_quality: assessment };
    return row;
  },
};
