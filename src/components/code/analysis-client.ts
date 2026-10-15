import type { AnalysisInput } from './analysis.worker';
import type { FunctionContext } from './function-context';
import type { MoveFile, MovedBlock } from './moves';

/*
 * Function context and moved lines are optional readings of a diff, worked out off the main
 * thread. A worker that cannot start, fails or takes over five seconds answers undefined, and the
 * diff shows without them.
 */

let worker: Worker | undefined;
let sequence = 0;
let idle: ReturnType<typeof setTimeout> | undefined;
const pending = new Map<number, { resolve: (value: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
function stop() {
  worker?.terminate(); worker = undefined;
  for (const task of pending.values()) { clearTimeout(task.timer); task.resolve(undefined); }
  pending.clear();
}
function request<T>(input: AnalysisInput): Promise<T | undefined> {
  return new Promise(resolve => {
    clearTimeout(idle);
    try {
      if (!worker) {
        worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
        worker.onerror = stop;
        worker.onmessage = ({ data }) => {
          const task = pending.get(data.id);
          if (!task) return;
          clearTimeout(task.timer); pending.delete(data.id);
          task.resolve(data.error ? undefined : data.value);
          if (!pending.size) idle = setTimeout(stop, 15_000);
        };
      }
      const id = ++sequence;
      pending.set(id, { resolve: value => resolve(value as T | undefined), timer: setTimeout(stop, 5_000) });
      worker.postMessage({ ...input, id });
    } catch { stop(); resolve(undefined); }
  });
}
export const analyzeContext = (language: string, before: string, after: string) => request<FunctionContext>({ kind: 'context', language, before, after });
export const analyzeMoves = (files: MoveFile[]) => request<MovedBlock[]>({ kind: 'moves', files });

