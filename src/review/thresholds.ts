import type { DecisionRecord, Judgment } from '../types.ts';

/**
 * 按题型推荐置信度阈值。
 *
 * 依据（laya-evals 的核心洞见）：一个全局 floor 是伪策略 ——
 * 二选一题目 0.865 能到 95% 准确率，20 选 1 要 0.994。
 * 阈值必须从"你自己的标注数据"按题型分桶算出来。
 *
 * 这里把校准闭环推进到最后一步：不是给人看报告，而是产出可直接
 * 写回配置、被内核加载生效的阈值表。
 */

/** 题型形状键：boolean / choice:N / score:N。与内核的 shapeOfQuestion 一致。 */
export type ShapeKey = string;

export interface ThresholdAdvice {
  shape: ShapeKey;
  samples: number;
  /** 推荐阈值：放行侧的最小把握 */
  floor: number;
  /** 该阈值下，自动放行部分的实测正确率 */
  precision: number;
  /** 该阈值下能自动放行的比例（越高越省人力） */
  coverage: number;
}

export interface ThresholdReport {
  advices: ThresholdAdvice[];
  /** 可直接写进 .vigil/thresholds.json 的映射，内核加载后按形状生效 */
  suggested: Record<string, number>;
  /** 样本不足或达不到目标精度的题型，如实列出 */
  insufficient: Array<{ shape: string; samples: number; best?: number }>;
}

export function shapeOfJudgment(j: Judgment): string {
  if (j.type === 'boolean') return 'boolean';
  if (j.type === 'choice') return `choice:${Object.keys(j.probabilities ?? {}).length || '?'}`;
  return 'score';
}

/** 内核侧：从问题定义直接推形状（比从答案反推可靠） */
export function shapeOfQuestion(type: string, optionCount?: number, scaleLength?: number): string {
  if (type === 'boolean') return 'boolean';
  if (type === 'choice') return `choice:${optionCount ?? '?'}`;
  return `score:${scaleLength ?? 5}`;
}

interface Sample {
  value: number;
  correct: boolean;
  gated: boolean;
}

/**
 * 从带标签的账本记录里按题型分桶，为每个桶找"达到目标精度的前提下，
 * 覆盖率最高的最小 floor"。没有标签的样本不参与 —— 这条纪律不能松。
 */
export function adviseThresholds(
  records: DecisionRecord[],
  options: { targetPrecision?: number; minSamples?: number; floors?: number[] } = {},
): ThresholdReport {
  const target = options.targetPrecision ?? 0.95;
  const minSamples = options.minSamples ?? 5;
  const floors = options.floors ?? [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.99];

  const buckets = new Map<string, Sample[]>();
  for (const record of records) {
    if (record.label === 'unknown') continue;
    const correct = record.label === 'correct';
    for (const j of record.judgments) {
      if (!j.valid || j.type === 'boolean' && (j as Judgment).direction === 'below') continue;
      const shape = shapeOfJudgment(j);
      if (!buckets.has(shape)) buckets.set(shape, []);
      const value = j.type === 'boolean' ? (j.probability ?? 0.5) : j.type === 'choice' ? (j.confidence) : (j.score ?? 0);
      buckets.get(shape)!.push({ value, correct, gated: record.outcome === 'allow' });
    }
  }

  const advices: ThresholdAdvice[] = [];
  const suggested: Record<string, number> = {};
  const insufficient: ThresholdReport['insufficient'] = [];

  for (const [shape, samples] of buckets) {
    if (samples.length < minSamples) {
      insufficient.push({ shape, samples: samples.length });
      continue;
    }
    let best: { floor: number; precision: number; coverage: number } | null = null;
    for (const floor of floors) {
      const gated = samples.filter((s) => s.value >= floor);
      if (gated.length === 0) continue;
      const precision = gated.filter((s) => s.correct).length / gated.length;
      const coverage = gated.length / samples.length;
      if (precision >= target && (!best || coverage > best.coverage)) {
        best = { floor, precision, coverage };
      }
    }
    if (!best) {
      insufficient.push({ shape, samples: samples.length, best: undefined });
      continue;
    }
    advices.push({ shape, samples: samples.length, floor: best.floor, precision: best.precision, coverage: best.coverage });
    suggested[shape] = best.floor;
  }

  advices.sort((a, b) => a.shape.localeCompare(b.shape));
  return { advices, suggested, insufficient };
}
