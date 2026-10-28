import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Notifier } from './notifier.ts';

/**
 * 决策循环的各个阶段。每个阶段都会发射一个事件，
 * 这是"实时知道"能力的底座：循环不再沉默地分析，而是把每一步都暴露出来。
 */
export type LoopStage =
  | 'goal_received'
  | 'plan'
  | 'evidence_gathered'
  | 'evidence_complete'
  | 'evidence_gap'
  | 'reasoning'
  | 'arbitrating'
  | 'decision'
  | 'gate'
  | 'executing'
  | 'completed'
  | 'paused'
  | 'resumed'
  | 'alert';

export type EventLevel = 'info' | 'alert' | 'gate';

export interface LoopEvent {
  ts: string;
  loopId: string;
  stage: LoopStage;
  level: EventLevel;
  message: string;
  data?: unknown;
}

export type EventSink = (event: LoopEvent) => void;

/**
 * 决策循环的事件总线。
 *
 * 调用方可以同步订阅（流式打印，边跑边看），也可以落盘成事件日志
 * 供 `vigil loop --watch <id>` 实时追踪 —— 即使对话关了也能回看每一步。
 */
export class LoopEventBus {
  readonly loopId: string;
  #sinks: EventSink[] = [];
  #logPath: string | undefined;
  #notifier: Notifier | undefined;

  constructor(loopId: string, opts?: { logPath?: string; notifier?: Notifier }) {
    this.loopId = loopId;
    this.#logPath = opts?.logPath;
    this.#notifier = opts?.notifier;
    if (this.#logPath) {
      const dir = dirname(this.#logPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
  }

  on(sink: EventSink): void {
    this.#sinks.push(sink);
  }

  /**
   * 发射事件：同步推给订阅者、落盘（供 --watch 回看），并异步推送到已配置通道。
   * 推送是旁路：失败只吞掉，绝不因通道抖动卡死决策循环。
   */
  emit(stage: LoopStage, level: EventLevel, message: string, data?: unknown): LoopEvent {
    const event: LoopEvent = {
      ts: new Date().toISOString(),
      loopId: this.loopId,
      stage,
      level,
      message,
    };
    if (data !== undefined) event.data = data;
    for (const sink of this.#sinks) sink(event);
    if (this.#logPath) appendFileSync(this.#logPath, `${JSON.stringify(event)}\n`);
    if (this.#notifier) {
      void this.#notifier.notify(event).catch((err) => {
        process.stderr.write(`[vigil] 推送失败（${this.#notifier?.id}）：${err instanceof Error ? err.message : String(err)}\n`);
      });
    }
    return event;
  }
}

export function loadEventLog(logPath: string): LoopEvent[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as LoopEvent);
}
