import * as v from 'valibot';
import { securityOf, type BraidEnv } from '../env';
import type { ProviderId, ProviderLimit } from '../../shared/providers';
import { ProviderFailure, type HostedProvider, type ProviderFailureCode, type ProviderLease } from './providers';
import { logFailure } from '../errors';
import { retryAfter as retryAfterMs } from './hosted-model';

/*
 * Calls to the providers people connect. Keys travel only in request headers to the provider's own API host, never
 * in a URL, and nothing a provider says in an error leaves this file: failures become `ProviderFailure` codes.
 */

const HOSTS: Record<ProviderId, string> = { openai: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com/v1', openrouter: 'https://openrouter.ai/api/v1' };
const headers = (provider: ProviderId, key: string): Record<string, string> => provider === 'anthropic'
  ? { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'user-agent': 'Braid' }
  : { authorization: `Bearer ${key}`, 'user-agent': 'Braid', ...(provider === 'openrouter' ? { 'x-title': 'Braid' } : {}) };

const providerError = v.object({ error: v.looseObject({ type: v.optional(v.string()), code: v.optional(v.pipe(v.union([v.string(), v.number()]), v.transform(String))) }) });
/** Reads the provider's status and its typed error `type` or `code` into Braid's code; the provider's message is never read. */
export function failureOf(provider: ProviderId, status: number, body: unknown, retryAfter?: number): ProviderFailure {
  const parsed = v.safeParse(providerError, body);
  const error = parsed.success ? parsed.output.error : {};
  const is = (...names: string[]) => names.some(name => name === error.type || name === error.code);
  const code: ProviderFailureCode = status === 401 ? 'auth'
    : status === 402 || is('insufficient_quota', 'billing_error', 'billing_hard_limit_reached', 'billing_not_active') ? 'quota'
    : status === 429 ? 'rate_limit'
    : status === 413 || is('context_length_exceeded', 'request_too_large') ? 'context'
    : status === 404 || is('model_not_found') ? 'model'
    : status === 403 ? 'forbidden'
    : status === 408 ? 'timeout'
    : status >= 500 ? 'unavailable'
    : 'invalid';
  return new ProviderFailure(provider, code, status, retryAfter);
}

async function call(provider: ProviderId, key: string, path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}) {
  let response: Response;
  try {
    response = await fetch(`${HOSTS[provider]}${path}`, {
      method: init.method ?? 'GET', redirect: 'manual', signal: init.signal ?? AbortSignal.timeout(15_000),
      headers: { ...headers(provider, key), ...(init.body ? { 'content-type': 'application/json' } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
  } catch (error) {
    logFailure('provider_call_unanswered', error, { provider });
    throw new ProviderFailure(provider, error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError') ? 'timeout' : 'unavailable');
  }
  let body: unknown = null;
  try { body = await response.json(); } catch { /* An unreadable answer is judged by its status below. */ }
  const delay = retryAfterMs(response.headers.get('retry-after'));
  const retryAfter = delay === undefined ? undefined : delay / 1000;
  if (!response.ok) throw response.status >= 300 && response.status < 400 ? new ProviderFailure(provider, 'unavailable', response.status) : failureOf(provider, response.status, body, retryAfter);
  // OpenRouter can answer 200 with an error from the model behind it.
  const embedded = v.safeParse(v.object({ error: v.looseObject({ code: v.optional(v.number()) }) }), body);
  if (embedded.success) throw failureOf(provider, embedded.output.error.code ?? 502, body, retryAfter);
  return { body, limits: limitsOf(provider, response.headers) };
}

/* ---------- limits ---------- */

/** OpenAI's resets read like `6m0s`, `1s` or `20ms`. */
function duration(value: string | null): number | undefined {
  if (!value) return undefined;
  let total = 0, matched = false;
  for (const [, amount, unit] of value.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    matched = true;
    total += Number(amount) * (unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : unit === 's' ? 1000 : 1);
  }
  return matched ? total : undefined;
}
const count = (value: string | null) => value !== null && /^\d+$/.test(value.trim()) ? Number(value) : undefined;
/** The rate limits a provider reports on each answer: OpenAI's `x-ratelimit-*` and Anthropic's `anthropic-ratelimit-*`. */
export function limitsOf(provider: ProviderId, headers: Headers, now = Date.now()): ProviderLimit[] {
  const limits: ProviderLimit[] = [];
  for (const kind of ['requests', 'tokens'] as const) {
    const [limit, remaining, reset] = provider === 'anthropic'
      ? [count(headers.get(`anthropic-ratelimit-${kind}-limit`)), count(headers.get(`anthropic-ratelimit-${kind}-remaining`)), headers.get(`anthropic-ratelimit-${kind}-reset`)]
      : [count(headers.get(`x-ratelimit-limit-${kind}`)), count(headers.get(`x-ratelimit-remaining-${kind}`)), headers.get(`x-ratelimit-reset-${kind}`)];
    if (remaining === undefined) continue;
    const at = provider === 'anthropic' ? (reset && !Number.isNaN(Date.parse(reset)) ? Date.parse(reset) : undefined) : (() => { const after = duration(reset); return after === undefined ? undefined : now + after; })();
    limits.push({ kind, remaining, ...(limit !== undefined ? { limit } : {}), ...(at !== undefined ? { resetsAt: new Date(at).toISOString() } : {}) });
  }
  return limits;
}

/* ---------- connecting ---------- */

const modelList = v.object({ data: v.pipe(v.array(v.looseObject({ id: v.pipe(v.string(), v.maxLength(200)), created: v.optional(v.number()), created_at: v.optional(v.string()),
  line: v.nullish(v.string()), lifecycle: v.optional(v.string()), supported_parameters: v.optional(v.array(v.string())) })), v.maxLength(5000)) });
/** OpenRouter's key answer: spend so far and, when the key has one, the credit limit left. */
const openRouterKey = v.object({ data: v.looseObject({ limit: v.nullish(v.number()), limit_remaining: v.nullish(v.number()), usage: v.optional(v.number()) }) });
// OpenAI's model listing has no capability fields. Explicit Responses/function-tool compatibility, never name guesses.
// https://developers.openai.com/api/docs/guides/function-calling
const OPENAI_TOOLS = ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-5.6-terra', 'gpt-5.5', 'gpt-5.4', 'gpt-5.2', 'gpt-5.1', 'gpt-5', 'gpt-4.1', 'gpt-5-mini', 'gpt-5-nano', 'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4o', 'gpt-4o-mini', 'o3', 'o4-mini'];

/** The models a key can run for an agent, newest first, and the one Braid starts with. */
export function chatModels(provider: ProviderId, answer: unknown): { models: string[]; model: string } | null {
  const parsed = v.safeParse(modelList, answer);
  if (!parsed.success) return null;
  const time = (model: (typeof parsed.output.data)[number]) => model.created ?? (Date.parse(model.created_at ?? '') || 0);
  const newest = [...parsed.output.data].sort((a, b) => time(b) - time(a));
  const supported = newest.filter(model => provider === 'openai' ? OPENAI_TOOLS.includes(model.id)
    : provider === 'openrouter' ? model.supported_parameters?.includes('tools') : model.lifecycle !== 'retired');
  const models = [...new Set(supported.map(model => model.id))].slice(0, 200);
  if (!models.length) return null;
  const preferred = provider === 'openai' ? OPENAI_TOOLS.find(id => models.includes(id))
    : provider === 'anthropic' ? supported.find(model => model.line === 'opus' || model.line === 'sonnet')?.id : undefined;
  return { models, model: preferred ?? models[0] };
}

/** Asks the provider about a key: whether it works, which models it runs and what it has left. */
export async function checkProviderKey(provider: ProviderId, key: string): Promise<{ models: string[]; model: string; limits: ProviderLimit[] }> {
  if (provider === 'openrouter') {
    const answer = await call(provider, key, '/key');
    const parsed = v.safeParse(openRouterKey, answer.body);
    if (!parsed.success) throw new ProviderFailure(provider, 'invalid');
    const { limit, limit_remaining: remaining } = parsed.output.data;
    const limits: ProviderLimit[] = typeof remaining === 'number' ? [{ kind: 'credit', remaining, ...(typeof limit === 'number' ? { limit } : {}) }] : [];
    const list = chatModels(provider, (await call(provider, key, '/models?supported_parameters=tools')).body);
    if (!list) throw new ProviderFailure(provider, 'invalid');
    return { ...list, limits };
  }
  const answer = await call(provider, key, provider === 'anthropic' ? '/models?limit=100' : '/models');
  const list = chatModels(provider, answer.body);
  if (!list) throw new ProviderFailure(provider, 'invalid');
  return { ...list, limits: answer.limits };
}

/* ---------- model turns ---------- */

const responseItem = v.variant('type', [
  v.looseObject({ type: v.literal('function_call'), call_id: v.string(), name: v.string(), arguments: v.string() }),
  v.looseObject({ type: v.literal('message'), role: v.literal('assistant'), content: v.array(v.variant('type', [
    v.looseObject({ type: v.literal('output_text'), text: v.string() }), v.looseObject({ type: v.literal('refusal'), refusal: v.string() }),
  ])) }),
  v.looseObject({ type: v.literal('reasoning') }),
]);
const responsesReply = v.object({ status: v.literal('completed'), output: v.array(responseItem) });
const message = v.looseObject({
  role: v.picklist(['system', 'user', 'assistant', 'tool']), content: v.nullish(v.string()),
  tool_calls: v.optional(v.array(v.object({ id: v.string(), type: v.optional(v.string()), function: v.object({ name: v.string(), arguments: v.string() }) }))),
  tool_call_id: v.optional(v.string()),
  /** An Anthropic reply's own content blocks, thinking included, which its next request must echo unchanged. */
  anthropic_content: v.optional(v.array(v.looseObject({ type: v.string() }))),
  openai_output: v.optional(v.array(responseItem)),
  reasoning_details: v.optional(v.array(v.looseObject({ type: v.string() }))),
  reasoning: v.nullish(v.string()), reasoning_content: v.nullish(v.string()),
});
type Message = v.InferOutput<typeof message>;
const tool = v.object({ type: v.literal('function'), function: v.object({ name: v.string(), description: v.optional(v.string()), parameters: v.record(v.string(), v.unknown()) }) });
/** What the agent loop sends: OpenAI-style messages and function tools. */
const turnInput = v.looseObject({ messages: v.pipe(v.array(message), v.minLength(1)), tools: v.array(tool), max_completion_tokens: v.optional(v.number()) });
/** What the agent loop reads back, as OpenAI's chat completions answer it. */
const chatReply = v.object({ choices: v.pipe(v.array(v.looseObject({ message: v.looseObject({ content: v.nullish(v.string()), tool_calls: v.nullish(v.array(v.unknown())) }) })), v.minLength(1)) });
const anthropicReply = v.object({
  content: v.array(v.union([
    v.looseObject({ type: v.literal('text'), text: v.string() }),
    v.looseObject({ type: v.literal('tool_use'), id: v.string(), name: v.string(), input: v.unknown() }),
    v.looseObject({ type: v.string() }),
  ])),
});

/** Only the fields every OpenAI-compatible API accepts; Workers AI models add others, such as reasoning text. */
const plain = (item: Message, provider: ProviderId) => ({ role: item.role, content: item.content ?? (item.tool_calls ? null : ''), ...(item.tool_calls ? { tool_calls: item.tool_calls.map(call => ({ id: call.id, type: 'function', function: call.function })) } : {}), ...(item.tool_call_id ? { tool_call_id: item.tool_call_id } : {}),
  ...(provider === 'openrouter' && item.role === 'assistant' ? item.reasoning_details ? { reasoning_details: item.reasoning_details } : item.reasoning || item.reasoning_content ? { reasoning: item.reasoning ?? item.reasoning_content } : {} : {}) });

/** Stateless Responses turns preserve encrypted reasoning and function call ids across checkpoints. */
export function responsesRequest(model: string, input: v.InferOutput<typeof turnInput>) {
  const items: unknown[] = [];
  for (const item of input.messages) {
    if (item.role === 'tool') { items.push({ type: 'function_call_output', call_id: item.tool_call_id ?? '', output: item.content ?? '' }); continue; }
    if (item.role === 'assistant' && item.openai_output) { items.push(...item.openai_output); continue; }
    if (item.content) items.push({ role: item.role, content: item.content });
    if (item.role === 'assistant') for (const call of item.tool_calls ?? []) items.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
  }
  return { model, input: items, store: false, include: ['reasoning.encrypted_content'], max_output_tokens: input.max_completion_tokens ?? 10_000,
    parallel_tool_calls: false, tools: input.tools.map(item => ({ type: 'function', ...item.function, strict: false })) };
}

/** Anthropic's Messages API takes the system prompt apart, tool calls as `tool_use` blocks and their output as `tool_result` blocks. */
export function anthropicRequest(model: string, input: v.InferOutput<typeof turnInput>) {
  const system = input.messages.filter(item => item.role === 'system').map(item => item.content ?? '').join('\n\n');
  const messages: { role: 'user' | 'assistant'; content: unknown[] }[] = [];
  const add = (role: 'user' | 'assistant', blocks: unknown[]) => {
    const last = messages.at(-1);
    if (last?.role === role) last.content.push(...blocks); else messages.push({ role, content: blocks });
  };
  for (const item of input.messages) {
    if (item.role === 'system') continue;
    if (item.role === 'tool') { add('user', [{ type: 'tool_result', tool_use_id: item.tool_call_id ?? '', content: item.content ?? '' }]); continue; }
    if (item.role === 'user') { add('user', [{ type: 'text', text: item.content || ' ' }]); continue; }
    // Anthropic refuses a rebuilt assistant turn when it held thinking, so its own blocks go back as they came.
    if (item.anthropic_content) { add('assistant', item.anthropic_content); continue; }
    add('assistant', [
      ...(item.content?.trim() ? [{ type: 'text', text: item.content }] : []),
      ...(item.tool_calls ?? []).map(call => {
        let args: unknown = {};
        try { args = JSON.parse(call.function.arguments); } catch { /* The loop already answered the bad arguments. */ }
        return { type: 'tool_use', id: call.id, name: call.function.name, input: args && typeof args === 'object' && !Array.isArray(args) ? args : {} };
      }),
    ]);
  }
  return {
    // Models after Claude Opus 4.6 refuse any temperature but the default.
    model, system, messages, max_tokens: Math.min(input.max_completion_tokens ?? 10_000, 32_000),
    tools: input.tools.map(item => ({ name: item.function.name, description: item.function.description ?? '', input_schema: item.function.parameters })),
    tool_choice: { type: 'auto', disable_parallel_tool_use: true },
  };
}

/** One model call with a lent key. Answers in the OpenAI chat shape the agent loop reads, whatever the provider. */
export async function providerCall(provider: ProviderId, lease: ProviderLease, model: string, input: unknown, signal: AbortSignal): Promise<{ reply: unknown; limits: ProviderLimit[] }> {
  const parsed = v.safeParse(turnInput, input);
  if (!parsed.success) throw new ProviderFailure(provider, 'invalid');
  if (provider === 'openai') {
    const answer = await call(provider, lease.key, '/responses', { method: 'POST', body: responsesRequest(model, parsed.output), signal });
    const reply = v.safeParse(responsesReply, answer.body);
    if (!reply.success) throw new ProviderFailure(provider, 'invalid');
    const content = reply.output.output.flatMap(item => item.type === 'message' ? item.content.flatMap(block => block.type === 'output_text' ? [block.text] : []) : []).join('\n');
    const calls = reply.output.output.flatMap(item => item.type === 'function_call' ? [{ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } }] : []);
    return { reply: { choices: [{ message: { role: 'assistant', content: content || null, ...(calls.length ? { tool_calls: calls } : {}), openai_output: reply.output.output } }] }, limits: answer.limits };
  }
  if (provider === 'anthropic') {
    const answer = await call(provider, lease.key, '/messages', { method: 'POST', body: anthropicRequest(model, parsed.output), signal });
    const reply = v.safeParse(anthropicReply, answer.body);
    if (!reply.success) throw new ProviderFailure(provider, 'invalid');
    const text = reply.output.content.flatMap(block => block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n');
    const calls = reply.output.content.flatMap(block => block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string'
      ? [{ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } }] : []);
    return { reply: { choices: [{ message: { role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}), anthropic_content: reply.output.content } }] }, limits: answer.limits };
  }
  const { messages, tools, max_completion_tokens: max = 10_000 } = parsed.output;
  // Use provider defaults instead of guessing model capabilities from its name.
  const body = { model, messages: messages.map(message => plain(message, provider)), tools, tool_choice: 'auto', parallel_tool_calls: false, max_tokens: max };
  const answer = await call(provider, lease.key, '/chat/completions', { method: 'POST', body, signal });
  if (!v.safeParse(chatReply, answer.body).success) throw new ProviderFailure(provider, 'invalid');
  return { reply: answer.body, limits: answer.limits };
}

/**
 * One model call with a person's own key; the sandbox's retry policy wraps it. The key is borrowed from Security for this call
 * and dropped after it, so removing or replacing the key stops the run at its next call, and no other key is ever
 * tried. Throws `ProviderFailure` with the provider's status and retry-after; records the outcome for the owner.
 */
export async function providerAttempt(env: Pick<BraidEnv, 'SECURITY'>, ref: HostedProvider, model: string, input: unknown, signal: AbortSignal): Promise<unknown> {
  const security = securityOf(env);
  const lease = await security.leaseProvider(ref);
  if (!lease) throw new ProviderFailure(ref.id, 'revoked');
  let failure: ProviderFailure;
  try {
    const { reply, limits } = await providerCall(ref.id, lease, model, input, signal);
    try { await security.recordProviderUse(ref, { ok: true, ...(limits.length ? { limits } : {}) }); }
    catch (error) { logFailure('provider_usage_record_failed', error, { provider: ref.id }); }
    return reply;
  } catch (error) { failure = error instanceof ProviderFailure ? error : new ProviderFailure(ref.id, 'unavailable'); }
  logFailure('provider_model_failed', failure, { provider: ref.id });
  // The owner's record is a courtesy; the run's own failure is what matters here.
  try { await security.recordProviderUse(ref, { ok: false, code: failure.code }); } catch (error) { logFailure('provider_usage_record_failed', error, { provider: ref.id }); }
  throw failure;
}
