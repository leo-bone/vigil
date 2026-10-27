import type { DecisionRecord } from '../types.ts';

export interface Bin {
  range: string;
  n: number;
  predicted: number;
  actual: number;
}

export interface SweepPoint {
  floor: number;
  coverage: number;
  precision: number;
}

export interface CalibrationReport {
  question: string;
  samples: number;
  labeled: number;
  /** 均方误差，越低越好；0.25 相当于一直猜 0.5 */
  brier: number | null;
  /** 期望校准误差，衡量"说 0.9 的时候有多准" */
  ece: number | null;
  bins: Bin[];
  sweep: SweepPoint[];
  verdict: string;
}

function binaryTruth(record: DecisionRecord): number | null {
  if (record.label === 'correct') return 1;
  if (record.label === 'wrong') return 0;
  return null;
}

/**
 * 置信度校准。
 *
 * 这是绝大多数 agent 系统缺的一块：模型说"我有 90% 把握"，
 * 但没人验证过那 90% 里有多少真的发生了。没有这个闭环，
 * 阈值就是拍脑袋定的，整个熔断规则都是玄学。
 */
export function calibrate(
  records: DecisionRecord[],
  options: { question?: string; bins?: number } = {},
): CalibrationReport {
  const question = options.question ?? 'proceed';
  const binCount = options.bins ?? 10;

  const pairs: Array<{ p: number; y: number }> = [];
  for (const record of records) {
    const truth = binaryTruth(record);
    if (truth === null) continue;
    const judgment = record.judgments.find(
      (j) => j.name === question && j.type === 'boolean' && j.valid && typeof j.probability === 'number',
    );
    if (!judgment) continue;
    pairs.push({ p: judgment.probability!, y: truth });
  }

  if (pairs.length === 0) {
    return {
      question,
      samples: 0,
      labeled: 0,
      brier: null,
      ece: null,
      bins: [],
      sweep: [],
      verdict: `没有找到可用的「${question}」判断样本。需要先给决策回填结果标签。`,
    };
  }

  const brier = pairs.reduce((sum, pair) => sum + (pair.p - pair.y) ** 2, 0) / pairs.length;

  const buckets: Array<{ predicted: number; actual: number; n: number }> = Array.from({ length: binCount }, () => ({
    predicted: 0,
    actual: 0,
    n: 0,
  }));
  for (const pair of pairs) {
    const index = Math.min(binCount - 1, Math.floor(pair.p * binCount));
    const bucket = buckets[index]!;
    bucket.predicted += pair.p;
    bucket.actual += pair.y;
    bucket.n += 1;
  }

  const bins: Bin[] = [];
  let ece = 0;
  buckets.forEach((bucket, index) => {
    if (bucket.n === 0) return;
    const predicted = bucket.predicted / bucket.n;
    const actual = bucket.actual / bucket.n;
    ece += (bucket.n / pairs.length) * Math.abs(predicted - actual);
    bins.push({
      range: `${(index / binCount).toFixed(1)}-${((index + 1) / binCount).toFixed(1)}`,
      n: bucket.n,
      predicted: Number(predicted.toFixed(3)),
      actual: Number(actual.toFixed(3)),
    });
  });

  const sweep: SweepPoint[] = [];
  for (let floor = 0.5; floor <= 0.96; floor += 0.05) {
    const passed = pairs.filter((pair) => pair.p >= floor);
    if (passed.length === 0) continue;
    sweep.push({
      floor: Number(floor.toFixed(2)),
      coverage: Number((passed.length / pairs.length).toFixed(3)),
      precision: Number((passed.reduce((s, pair) => s + pair.y, 0) / passed.length).toFixed(3)),
    });
  }

  let verdict: string;
  if (ece <= 0.05) verdict = '校准良好，当前阈值可以信任。';
  else if (ece <= 0.12) verdict = '校准尚可，接近阈值时建议人工抽查。';
  else verdict = '校准偏差较大，模型自报的把握不可直接当阈值用，需要按实测结果重设 floor。';

  return {
    question,
    samples: pairs.length,
    labeled: pairs.length,
    brier: Number(brier.toFixed(4)),
    ece: Number(ece.toFixed(4)),
    bins,
    sweep,
    verdict,
  };
}
