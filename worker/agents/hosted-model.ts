import * as v from 'valibot';
import type { HostedEnvironment } from '../../shared/types';
import { hostedErrors } from './errors';
import { hostedProviderError, parseWorkersAiError } from '../schemas';
import { readOutput } from './container';
import { failure, HostedFailureError, retryHosted, type HostedRetryOptions } from './hosted-failures';
import { ProviderFailure } from './providers';
import type { ProviderId } from '../../shared/providers';
import { MODEL_TIMEOUT, TASK_MINUTES } from './hosted-limits';

export function retryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value === null) return;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

const providerError = v.pipe(v.string(), v.parseJson(), hostedProviderError);
function providerFailure(status?: number, code?: number, delay?: number) {
  const reason = code === 3007 || code === 3008 ? 'timeout' : code === 3040 ? 'capacity'
    : code === 3036 ? 'quota' : code === 3006 ? 'context'
    : code && [5007, 5004, 3003, 5018, 5016, 3023, 3041, 5035, 5019, 5005, 3042].includes(code) ? 'configuration' : 'unavailable';
  const result = failure(reason === 'timeout' ? 'timeout' : 'provider', 'model', { source: 'workers_ai', operation: 'model request',
    ...(status !== undefined ? { status } : {}), ...(code !== undefined ? { providerCode: code } : {}), ...(delay !== undefined ? { retryAfterMs: delay } : {}),
  }, '', hostedErrors[reason]);
  result.retryable = !['timeout', 'quota', 'context', 'configuration'].includes(reason) &&
    (status !== undefined ? status >= 500 && status <= 599 || status === 429 && delay !== undefined : code === 3040);
  // A provider-enforced deadline cannot be extended by increasing Braid's task budget.
  if (reason === 'timeout') result.action = 'retry';
  return result;
}

/** Raw responses keep HTTP status and Retry-After on this request, avoiding the binding's mutable lastRequest fields. */
export async function hostedModelTurn(ai: Ai, model: string, input: unknown, deadline: number, checkpoint: (message?: string) => Promise<unknown>,
  report?: (message: string, environment: HostedEnvironment) => Promise<unknown>, attempts?: HostedRetryOptions['attempts'], requestTimeout = MODEL_TIMEOUT, provider?: ProviderId, taskLimit = TASK_MINUTES * 60_000): Promise<unknown> {
  const deadlineFailure = () => {
    const exhausted = Date.now() >= deadline;
    const reason = failure('timeout', 'model', { source: provider ? 'provider' : 'workers_ai', operation: provider ?? 'model request', timedOut: true,
      limitKind: exhausted ? 'task' : 'model', timeoutMs: exhausted ? taskLimit : requestTimeout, elapsedMs: exhausted ? taskLimit : requestTimeout });
    if (Date.now() < deadline) reason.action = 'retry';
    return reason;
  };
  return retryHosted(async () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new HostedFailureError(deadlineFailure());
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          let response: unknown;
          try { response = await ai.run(model as Parameters<Ai['run']>[0], input as never, { signal: controller.signal, returnRawResponse: true }); }
          catch (error) {
            if (error instanceof ProviderFailure) {
              const reason = failure(error.code === 'timeout' ? 'timeout' : 'provider', 'model', { source: 'provider', operation: error.provider,
                code: error.code, ...(error.status !== undefined ? { status: error.status } : {}), ...(error.retryAfter !== undefined ? { retryAfterMs: error.retryAfter * 1000 } : {}) }, '', error.message);
              reason.retryable = error.code === 'unavailable' && (error.status === undefined || error.status >= 500 && error.status <= 599)
                || error.code === 'rate_limit' && error.retryAfter !== undefined;
              if (error.code === 'timeout') reason.action = 'retry';
              throw new HostedFailureError(reason);
            }
            if (provider) throw new HostedFailureError(failure('provider', 'model', { source: 'provider', operation: provider, code: 'unavailable' }, '', 'The model provider could not complete the request.'));
            // Older bindings encode a numeric Workers AI code in a documented prefix. Never classify its description.
            throw new HostedFailureError(providerFailure(undefined, parseWorkersAiError(error)));
          }
          if (!(response instanceof Response)) return response;
          const output = await readOutput(response.body, response.ok ? 2 * 1024 * 1024 : 16 * 1024);
          if (!response.ok) {
            const parsed = v.safeParse(providerError, output.text);
            const code = parsed.success ? parsed.output.internalCode ?? parsed.output.errors?.[0]?.code : undefined;
            throw new HostedFailureError(providerFailure(response.status, code, retryAfter(response.headers.get('retry-after'))));
          }
          if (output.truncated) throw new HostedFailureError(failure('provider', 'model', { source: 'workers_ai', operation: 'model response', status: response.status, truncated: true }, '', hostedErrors.response));
          try { return JSON.parse(output.text); }
          catch { throw new HostedFailureError(failure('provider', 'model', { source: 'workers_ai', operation: 'model response', status: response.status }, '', hostedErrors.response)); }
        })(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new HostedFailureError(deadlineFailure())); }, Math.min(requestTimeout, remaining)); }),
      ]);
    } finally { clearTimeout(timer); }
  }, { phase: 'model', operation: 'model request', deadline, authorize: () => checkpoint(), attempts,
    report: report ?? ((message) => checkpoint(message)),
  });
}
