import { canonical, hash } from './message.ts';

export const CPU_CORE_METRIC = /^cpu_core_[0-9]+_temperature_c$/;
export const PG_METRIC_PROJECTION_ID = 'cpu-package-only';
export const PG_METRIC_PROJECTION_VERSION = '1';

export interface PostgresMetricProjection {
  metrics: Record<string, number>;
  lineage: Record<string, unknown>;
  resultHash: string;
  removedMetrics: string[];
}

/**
 * PG 加工层只保留 CPU 封装温度，单核心读数仍留在 MQTT / SQLite / D1，供告警使用。
 * 不计算均值、最大值或零值来冒充封装温度；全为核心指标时保留空 metrics 作为幂等回执。
 *
 * 原结果哈希覆盖完整加工结果。以它和保留指标构成版本化投影哈希，既让历史清理可直接
 * 使用旧 result_sha256，又让升级前 SQLite 队列的重试与清理后的 PG 行保持一致。
 * 不改变 message_id、payload_sha256、处理器身份、时间或原始层；此函数只在 PG sink 使用。
 */
export function projectMetricsForPostgres(
  metrics: Record<string, number>,
  sourceResultSha256: string,
  lineage: Record<string, unknown> = {},
): PostgresMetricProjection {
  const removedMetrics = Object.keys(metrics).filter(key => CPU_CORE_METRIC.test(key)).sort();
  if (!removedMetrics.length) return { metrics, lineage, resultHash: sourceResultSha256, removedMetrics };
  if (!/^[0-9a-f]{64}$/.test(sourceResultSha256)) throw new Error('Missing original result hash for CPU metric projection');
  // A partially edited row must not be double-wrapped or guessed into a new hash contract.
  if (Object.hasOwn(lineage, 'pg_metric_projection')) throw new Error('CPU metric projection already recorded on unfiltered metrics');
  const retained = Object.fromEntries(Object.entries(metrics).filter(([key]) => !CPU_CORE_METRIC.test(key)));
  return {
    metrics: retained,
    lineage: { ...lineage, pg_metric_projection: {
      id: PG_METRIC_PROJECTION_ID, version: PG_METRIC_PROJECTION_VERSION,
      source_result_sha256: sourceResultSha256, removed_metrics: removedMetrics,
    } },
    resultHash: hash(canonical({
      projection_id: PG_METRIC_PROJECTION_ID, projection_version: PG_METRIC_PROJECTION_VERSION,
      source_result_sha256: sourceResultSha256, metrics: retained,
    })),
    removedMetrics,
  };
}
