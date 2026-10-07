export type MetricQualityStatus = 'ok' | 'out_of_spec' | 'missing' | 'invalid';

export interface MetricAssessment {
  status: MetricQualityStatus;
  minimum: number;
  maximum: number;
  unit: '°C' | '%RH';
}

export interface MetricQualityAssessment {
  rule_id: 'wsdcgq01lm-official-detection-range';
  rule_version: '1';
  metrics: {
    temperature_c: MetricAssessment;
    humidity_pct: MetricAssessment;
  };
}

interface QualityInput {
  source?: Readonly<Record<string, unknown>>;
  metrics: Readonly<Record<string, unknown>>;
}

function assess(value: unknown, minimum: number, maximum: number, unit: MetricAssessment['unit']): MetricAssessment {
  const status: MetricQualityStatus = value === undefined ? 'missing'
    : typeof value !== 'number' || !Number.isFinite(value) ? 'invalid'
    : value < minimum || value > maximum ? 'out_of_spec' : 'ok';
  return { status, minimum, maximum, unit };
}

// 小米官方 WSDCGQ01LM 说明书（繁中印刷第 54 页）给出检测范围及精度：
// 温度 -20～50°C、±0.3°C；湿度 10～90%RH、±3%RH，适用条件为无冷凝。
// https://i01.appmifile.com/webfile/globalimg/Global_UG/Mi_Ecosystem/Mi_Temperature_and_Humidity_Sensor/Temperature_Sensor_fr_V1.pdf#page=56
// 这是检测规格，不是另一个工作范围；精度不用于扩展范围，也不能由数值判断是否冷凝。
// 超规格不等于设备损坏。只产生逐指标质量说明，不改原值、消息 quality 或身份/哈希。
export function assessMetricQuality(sample: QualityInput): MetricQualityAssessment | undefined {
  if (sample.source?.driver !== 'xiaomi-gateway-v3-temperature' || sample.source.sensor_model !== 'WSDCGQ01LM') return undefined;
  return {
    rule_id: 'wsdcgq01lm-official-detection-range',
    rule_version: '1',
    metrics: {
      temperature_c: assess(sample.metrics.temperature_c, -20, 50, '°C'),
      humidity_pct: assess(sample.metrics.humidity_pct, 10, 90, '%RH'),
    },
  };
}
