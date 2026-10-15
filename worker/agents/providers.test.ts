import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BraidEnv } from '../env';
import { Security } from '../accounts/security';
import { storageFixture } from '../test/storage';
import { openProviderKey, ProviderFailure, sealProviderKey, type HostedProvider } from './providers';
import { anthropicRequest, chatModels, failureOf, limitsOf, providerAttempt, providerCall, responsesRequest } from './provider-client';
import { providerRoute } from './provider-routes';
import type { ProviderConnection } from '../../shared/providers';

const SECRET = { SESSION_SECRET: 's'.repeat(48) };
const OPENAI_KEY = 'sk-proj-fixtureOpenAIKey0123456789abcdef';
const ANTHROPIC_KEY = 'sk-ant-api03-fixtureAnthropicKey0123456789';
const alice = { id: 'alice', email: 'alice@example.test', name: 'Alice' }, bob = { id: 'bob', email: 'bob@example.test', name: 'Bob' };
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** A Security object on real SQLite, a fake provider network that checks where keys go, and every log line. */
function fixture(answer: (url: URL, init: RequestInit) => Response = defaultAnswer) {
  const db = storageFixture();
  const security = new Security(db.ctx, SECRET as BraidEnv);
  const env = { ...SECRET, SECURITY: { idFromName: (name: string) => name, get: () => security } } as unknown as BraidEnv;
  const calls: { url: URL; headers: Headers; body: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, headers: new Headers(init.headers), body: String(init.body ?? '') });
    return answer(url, init);
  }));
  const logs: string[] = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
  const route = (path: string, method = 'GET', body?: unknown, user: typeof alice | null = alice, scope?: 'work') => providerRoute(new Request(`https://braid.example${path}`, {
    method, headers: { origin: 'https://braid.example', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  }), env, user, scope).catch((error: { status: number; message: string }) => Response.json({ error: error.message }, { status: error.status }));
  const rows = () => (security.providers(''), db.storage.sql.exec<{ user_id: string; provider: string; secret: string; meta: string }>('SELECT * FROM provider_credentials').toArray());
  return { db, security, env, calls, logs, route, rows };
}
function defaultAnswer(url: URL, init: RequestInit) {
  const key = new Headers(init.headers).get('authorization')?.slice(7) ?? new Headers(init.headers).get('x-api-key');
  if (key !== OPENAI_KEY && key !== ANTHROPIC_KEY) return Response.json({ error: { type: 'authentication_error', code: 'invalid_api_key', message: `Incorrect API key provided: ${key}` } }, { status: 401 });
  if (url.pathname === '/v1/models') return Response.json({ data: [
    { id: 'gpt-5-mini', created: 3 }, { id: 'gpt-5', created: 2 }, { id: 'text-embedding-3-large', created: 4 }, { id: 'gpt-5-2025-08-07', created: 5 }, { id: 'gpt-4.1', created: 1 },
  ] }, { headers: { 'x-ratelimit-remaining-requests': '4999', 'x-ratelimit-limit-requests': '5000', 'x-ratelimit-reset-requests': '12ms' } });
  if (url.pathname === '/v1/responses') return Response.json({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] }] }, { headers: { 'x-ratelimit-remaining-tokens': '790000', 'x-ratelimit-limit-tokens': '800000', 'x-ratelimit-reset-tokens': '6m0s' } });
  throw new Error(`Unexpected provider call ${url}`);
}
/** Every place a key could leak in these flows: answers, log lines and stored rows. */
const leaks = (text: string) => [OPENAI_KEY, ANTHROPIC_KEY, OPENAI_KEY.slice(8, 30)].some(secret => text.includes(secret));

it('echoes OpenRouter reasoning signatures unchanged across tool turns', async () => {
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => { requests.push(JSON.parse(String(init.body))); return Response.json({ choices: [{ message: { content: 'Done.' } }] }); }));
  const reasoning = [{ type: 'reasoning.encrypted', data: 'signed-provider-state', id: 'reasoning-id', format: 'google-gemini-v1', index: 0 }];
  await providerCall('openrouter', { key: 'fixture', model: 'google/gemini-3', version: 'v' }, 'google/gemini-3', {
    messages: [{ role: 'user', content: 'Task' }, { role: 'assistant', content: null, reasoning_details: reasoning,
      tool_calls: [{ id: 'exec', function: { name: 'exec', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'exec', content: 'Done' }], tools: [],
  }, AbortSignal.timeout(5000));
  expect((requests[0].messages as Record<string, unknown>[])[1].reasoning_details).toEqual(reasoning);
});
it('uses OpenAI Responses and replays reasoning and function call ids unchanged', async () => {
  const output = [{ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'encrypted-state' },
    { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'exec', arguments: '{"command":"pwd"}', status: 'completed' }];
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init: RequestInit) => { requests.push({ url: String(url), body: JSON.parse(String(init.body)) }); return Response.json({ status: 'completed', output }); }));
  const { reply } = await providerCall('openai', { key: OPENAI_KEY, model: 'gpt-6-astra', version: 'v' }, 'gpt-6-astra', {
    messages: [{ role: 'user', content: 'Task' }], tools: [{ type: 'function', function: { name: 'exec', parameters: { type: 'object', properties: { command: { type: 'string' } } } } }],
  }, AbortSignal.timeout(5000));
  expect(requests[0]).toMatchObject({ url: 'https://api.openai.com/v1/responses', body: { store: false, include: ['reasoning.encrypted_content'], tools: [{ type: 'function', name: 'exec', strict: false }] } });
  const message = (reply as { choices: { message: unknown }[] }).choices[0].message;
  expect(message).toMatchObject({ tool_calls: [{ id: 'call_1', function: { name: 'exec', arguments: '{"command":"pwd"}' } }], openai_output: output });
  const next = responsesRequest('gpt-6-astra', { messages: [{ role: 'user', content: 'Task' }, message as never, { role: 'tool', tool_call_id: 'call_1', content: '{"stdout":"/workspace/repository"}' }], tools: [] });
  expect(next.input).toEqual([{ role: 'user', content: 'Task' }, ...output, { type: 'function_call_output', call_id: 'call_1', output: '{"stdout":"/workspace/repository"}' }]);
});
it('accepts only explicit model compatibility and provider capability fields', () => {
  expect(chatModels('openai', { data: [{ id: 'gpt-99-looks-like-a-chat-model', created: 99 }, { id: 'gpt-6-astra', created: 1 }, { id: 'gpt-image-1', created: 100 }] }))
    .toEqual({ model: 'gpt-6-astra', models: ['gpt-6-astra'] });
  expect(chatModels('openrouter', { data: [{ id: 'unfamiliar/tool-model', supported_parameters: ['tools'], created: 1 }, { id: 'openai/gpt-no-tools', supported_parameters: [], created: 99 }] }))
    .toEqual({ model: 'unfamiliar/tool-model', models: ['unfamiliar/tool-model'] });
  expect(chatModels('anthropic', { data: [{ id: 'retired', lifecycle: 'retired', created: 99 }, { id: 'new-name', line: 'opus', created: 1 }, { id: 'claude-sonnet-99', line: 'haiku', created: 2 }] }))
    .toEqual({ model: 'new-name', models: ['claude-sonnet-99', 'new-name'] });
});
it('keeps HTTP-date Retry-After as typed retry timing', async () => {
  const at = Math.floor(Date.now() / 1000) * 1000;
  vi.spyOn(Date, 'now').mockReturnValue(at);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { type: 'rate_limit_error' } }, { status: 429, headers: { 'retry-after': new Date(at + 7000).toUTCString() } })));
  await expect(providerCall('openai', { key: OPENAI_KEY, model: 'gpt-5', version: 'v' }, 'gpt-5', { messages: [{ role: 'user', content: 'Task' }], tools: [] }, AbortSignal.timeout(5000)))
    .rejects.toMatchObject({ code: 'rate_limit', retryAfter: 7 });
});

describe('provider key sealing', () => {
  it('round-trips a key and binds it to its owner, its provider and the deployment secret', async () => {
    const sealed = await sealProviderKey(SECRET, 'alice', 'openai', OPENAI_KEY);
    expect(leaks(sealed)).toBe(false);
    expect(await sealProviderKey(SECRET, 'alice', 'openai', OPENAI_KEY)).not.toBe(sealed);
    expect(await openProviderKey(SECRET, 'alice', 'openai', sealed)).toBe(OPENAI_KEY);
    expect(await openProviderKey(SECRET, 'bob', 'openai', sealed)).toBeNull();
    expect(await openProviderKey(SECRET, 'alice', 'openrouter', sealed)).toBeNull();
    expect(await openProviderKey({ SESSION_SECRET: 't'.repeat(48) }, 'alice', 'openai', sealed)).toBeNull();
    expect(await openProviderKey(SECRET, 'alice', 'openai', `${sealed.slice(0, -2)}AA`)).toBeNull();
  });
  it('refuses to seal without a deployment secret', async () => {
    await expect(sealProviderKey({ SESSION_SECRET: '' }, 'alice', 'openai', OPENAI_KEY)).rejects.toThrow(/not configured/);
  });
});

describe('provider routes', () => {
  it('connects a key, shows only its state, and never returns, logs or stores it in the clear', async () => {
    const f = fixture();
    const connected = await f.route('/api/providers/openai', 'PUT', { key: OPENAI_KEY });
    expect(connected.status).toBe(200);
    const text = await connected.text();
    const connection = JSON.parse(text) as ProviderConnection;
    expect(connection).toMatchObject({ provider: 'openai', model: 'gpt-5', models: ['gpt-5-mini', 'gpt-5', 'gpt-4.1'], status: 'ready', limits: [{ kind: 'requests', remaining: 4999, limit: 5000 }] });
    const listed = await (await f.route('/api/providers')).text();
    expect(JSON.parse(listed)).toEqual({ providers: [connection] });
    const checked = await (await f.route('/api/providers/openai/check', 'POST', {})).text();
    const chosen = await (await f.route('/api/providers/openai', 'PATCH', { model: 'gpt-4.1' })).text();
    expect(JSON.parse(chosen)).toMatchObject({ model: 'gpt-4.1' });
    for (const answer of [text, listed, checked, chosen, JSON.stringify(f.rows()), ...f.logs]) expect(leaks(answer)).toBe(false);
    // The key went to OpenAI's API host in a header, never in a URL.
    for (const call of f.calls) {
      expect(call.url.origin).toBe('https://api.openai.com');
      expect(leaks(call.url.href)).toBe(false);
      expect(call.headers.get('authorization')).toBe(`Bearer ${OPENAI_KEY}`);
    }
  });
  it('names a bad key plainly before and after asking the provider', async () => {
    const f = fixture();
    const refused = async (body: unknown, provider = 'openai') => { const response = await f.route(`/api/providers/${provider}`, 'PUT', body); return { status: response.status, ...await response.json() as { error: string } }; };
    expect(await refused({ key: 'nope' })).toMatchObject({ status: 400, error: 'Paste the whole API key.' });
    expect(await refused({ key: 'sk-or-v1-0123456789abcdef0123' }, 'anthropic')).toMatchObject({ status: 400, error: 'Anthropic API keys start with sk-ant-' });
    expect(await refused({ key: 'sk-ant-oat01-0123456789abcdef0123' }, 'anthropic')).toMatchObject({ status: 400, error: expect.stringMatching(/Claude plan token.*local agent/) });
    expect(await refused({ key: 'sk-proj-with space-0123456789abcdef' })).toMatchObject({ status: 400 });
    const wrong = await refused({ key: 'sk-proj-wrongKey0123456789abcdef0123' });
    expect(wrong).toMatchObject({ status: 400, error: 'OpenAI rejected this key. Check that you pasted the whole key and that it is active.' });
    // The provider's own message, which repeats the key, never reaches the person or the logs; its status does.
    expect(JSON.stringify(wrong)).not.toContain('Incorrect API key');
    expect(f.logs).toContain(JSON.stringify({ event: 'provider_key_refused', provider: 'openai', error: 'ProviderFailure', code: 'auth', status: 401 }));
    expect(f.logs.join('\n')).not.toContain('wrongKey');
    expect(f.rows()).toHaveLength(0);
  });
  it('says which Anthropic keys work when Anthropic refuses one it authenticated', async () => {
    const f = fixture(() => Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'Provider wording Braid never reads' } }, { status: 400 }));
    const response = await f.route('/api/providers/anthropic', 'PUT', { key: ANTHROPIC_KEY });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'Anthropic refused requests from this key. Use a key created inside a workspace, and check that workspace’s spend limit.' });
    expect(f.logs).toContain(JSON.stringify({ event: 'provider_key_refused', provider: 'anthropic', error: 'ProviderFailure', code: 'invalid', status: 400 }));
    expect(f.rows()).toHaveLength(0);
  });
  it('logs why a provider gave no answer, without the key', async () => {
    const f = fixture(() => { throw new TypeError(`Network connection lost while sending ${ANTHROPIC_KEY}`); });
    const response = await f.route('/api/providers/anthropic', 'PUT', { key: ANTHROPIC_KEY });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: 'Anthropic could not be reached. Try again shortly.' });
    expect(f.logs).toContain(JSON.stringify({ event: 'provider_call_unanswered', provider: 'anthropic', error: 'TypeError' }));
    expect(f.logs.join('\n')).not.toContain('Network connection lost while sending');
    expect(f.logs).toContain(JSON.stringify({ event: 'provider_key_refused', provider: 'anthropic', error: 'ProviderFailure', code: 'unavailable' }));
    expect(f.logs.some(leaks)).toBe(false);
  });
  it('serves only the signed-in person, never an agent connection, and keeps each person’s keys apart', async () => {
    const f = fixture();
    expect((await f.route('/api/providers', 'GET', undefined, null)).status).toBe(401);
    expect((await f.route('/api/providers/openai', 'PUT', { key: OPENAI_KEY }, alice, 'work')).status).toBe(403);
    expect((await f.route('/api/providers/github', 'PUT', { key: OPENAI_KEY })).status).toBe(400);
    expect((await f.route('/api/providers/openai', 'PUT', { key: OPENAI_KEY })).status).toBe(200);
    expect(await (await f.route('/api/providers', 'GET', undefined, bob)).json()).toEqual({ providers: [] });
    expect((await f.route('/api/providers/openai/check', 'POST', {}, bob)).status).toBe(404);
    expect((await f.route('/api/providers/openai', 'PATCH', { model: 'gpt-5' }, bob)).status).toBe(404);
    expect((await f.route('/api/providers/openai', 'PATCH', { model: 'o9-imaginary' })).status).toBe(400);
    const cross = await providerRoute(new Request('https://braid.example/api/providers/openai', { method: 'DELETE', headers: { origin: 'https://evil.example' } }), f.env, alice).catch((error: { status: number }) => error.status);
    expect(cross).toBe(403);
  });
});

describe('lending a key to a hosted run', () => {
  async function connected() {
    const f = fixture();
    await f.route('/api/providers/openai', 'PUT', { key: OPENAI_KEY });
    const choice = f.security.providerChoice('alice', 'openai');
    if (!choice.ok) throw new Error(choice.error);
    const ref: HostedProvider = { id: 'openai', owner: 'alice', version: choice.version };
    return { ...f, ref, choice };
  }
  const input = { messages: [{ role: 'system', content: 'Work.' }, { role: 'user', content: 'Task' }], tools: [], max_completion_tokens: 100 };

  it('lends the key only to its owner’s run, for one call, and records when it ran', async () => {
    const f = await connected();
    expect(f.choice).toMatchObject({ ok: true, model: 'gpt-5' });
    expect(await f.security.leaseProvider(f.ref)).toMatchObject({ key: OPENAI_KEY });
    expect(await f.security.leaseProvider({ ...f.ref, owner: 'bob' })).toBeNull();
    expect(await f.security.leaseProvider({ ...f.ref, id: 'anthropic' })).toBeNull();
    expect(f.security.providerChoice('bob', 'openai')).toEqual({ ok: false, error: 'Connect OpenAI in Settings → Providers first.' });
    const reply = await providerAttempt(f.env, f.ref, 'gpt-5', input, AbortSignal.timeout(5000));
    expect(reply).toMatchObject({ choices: [{ message: { content: 'Done.' } }] });
    const call = f.calls.at(-1)!;
    expect(call.url.href).toBe('https://api.openai.com/v1/responses');
    expect(JSON.parse(call.body)).toMatchObject({ model: 'gpt-5', parallel_tool_calls: false });
    expect(JSON.parse(call.body)).not.toHaveProperty('reasoning_effort');
    expect(JSON.parse(call.body)).not.toHaveProperty('temperature');
    expect(leaks(call.body)).toBe(false);
    const [state] = f.security.providers('alice');
    expect(state.lastUsedAt).toBeTruthy();
    expect(state.limits).toContainEqual(expect.objectContaining({ kind: 'tokens', remaining: 790000, limit: 800000 }));
    expect(f.logs.some(leaks)).toBe(false);
  });
  it('keeps a successful model answer when usage bookkeeping fails', async () => {
    const f = await connected();
    vi.spyOn(f.security, 'recordProviderUse').mockImplementation(() => { throw new Error('storage unavailable'); });
    await expect(providerAttempt(f.env, f.ref, 'gpt-5', input, AbortSignal.timeout(5000))).resolves.toMatchObject({ choices: [{ message: { content: 'Done.' } }] });
    expect(f.calls.filter(call => call.url.pathname.endsWith('/responses'))).toHaveLength(1);
    expect(f.logs.join('\n')).toContain('provider_usage_record_failed');
  });
  it('stops a run at its next call once the key is removed or replaced, and never uses another key', async () => {
    const f = await connected();
    await f.route('/api/providers/openai', 'DELETE');
    await expect(providerAttempt(f.env, f.ref, 'gpt-5', input, AbortSignal.timeout(5000))).rejects.toThrow('The OpenAI connection was removed. No proposal was published. Connect OpenAI in Settings → Providers, then start again.');
    await f.route('/api/providers/openai', 'PUT', { key: OPENAI_KEY });
    const calls = f.calls.length;
    await expect(providerAttempt(f.env, f.ref, 'gpt-5', input, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'revoked' });
    expect(f.calls).toHaveLength(calls);
  });
  it('marks a rejected key for reconnecting and refuses it to new tasks', async () => {
    let reject = false;
    const f = fixture((url, init) => reject ? Response.json({ error: { message: `bad key ${OPENAI_KEY}`, code: 'invalid_api_key' } }, { status: 401 }) : defaultAnswer(url, init));
    await f.route('/api/providers/openai', 'PUT', { key: OPENAI_KEY });
    const choice = f.security.providerChoice('alice', 'openai');
    if (!choice.ok) throw new Error(choice.error);
    reject = true;
    const error = await providerAttempt(f.env, { id: 'openai', owner: 'alice', version: choice.version }, 'gpt-5', input, AbortSignal.timeout(5000)).catch(caught => caught);
    if (!(error instanceof ProviderFailure)) throw error;
    expect(error).toMatchObject({ code: 'auth', status: 401, retryable: false, message: 'OpenAI rejected the saved key. No proposal was published. Reconnect OpenAI in Settings → Providers, then start again.' });
    expect(f.security.providers('alice')[0]).toMatchObject({ status: 'rejected', error: 'Key rejected' });
    expect(f.security.providerChoice('alice', 'openai')).toEqual({ ok: false, error: 'OpenAI rejected the saved key. Reconnect it in Settings → Providers.' });
    expect(await f.security.leaseProvider({ id: 'openai', owner: 'alice', version: choice.version })).toBeNull();
    expect(f.logs.join('\n')).toContain('"code":"auth"');
    expect(f.logs.some(leaks)).toBe(false);
    // Reconnecting with a working key clears it.
    reject = false;
    expect(await (await f.route('/api/providers/openai', 'PUT', { key: OPENAI_KEY })).json()).toMatchObject({ status: 'ready' });
  });
});

describe('provider answers at the boundary', () => {
  it('maps provider statuses and error bodies to codes without keeping their text', () => {
    const cases: [number, unknown, string][] = [
      [401, {}, 'auth'], [403, {}, 'forbidden'], [404, { error: { code: 'model_not_found' } }, 'model'],
      [429, { error: { code: 'rate_limit_exceeded' } }, 'rate_limit'], [429, { error: { code: 'insufficient_quota' } }, 'quota'], [402, {}, 'quota'],
      [400, { error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }, 'invalid'],
      [400, { error: { code: 'context_length_exceeded' } }, 'context'], [400, { error: { type: 'invalid_request_error', message: 'prompt is too long: 250000 tokens' } }, 'invalid'],
      [400, { error: { type: 'billing_error' } }, 'quota'], [413, { error: { type: 'request_too_large' } }, 'context'],
      [400, { error: 'not an object' }, 'invalid'], [529, { error: { type: 'overloaded_error' } }, 'unavailable'], [503, null, 'unavailable'],
    ];
    for (const [status, body, code] of cases) expect([status, failureOf('anthropic', status, body).code]).toEqual([status, code]);
    const failure = failureOf('openai', 429, {}, 7);
    expect(failure).toMatchObject({ status: 429, retryAfter: 7, retryable: true });
  });
  it('reads rate limits from headers and model lists with Valibot', () => {
    const now = Date.parse('2026-10-14T00:00:00Z');
    expect(limitsOf('openai', new Headers({ 'x-ratelimit-remaining-requests': '9', 'x-ratelimit-limit-requests': '10', 'x-ratelimit-reset-requests': '1m30s' }), now))
      .toEqual([{ kind: 'requests', remaining: 9, limit: 10, resetsAt: '2026-10-14T00:01:30.000Z' }]);
    expect(limitsOf('anthropic', new Headers({ 'anthropic-ratelimit-tokens-remaining': '100', 'anthropic-ratelimit-tokens-reset': '2026-10-14T00:05:00Z' }), now))
      .toEqual([{ kind: 'tokens', remaining: 100, resetsAt: '2026-10-14T00:05:00.000Z' }]);
    expect(limitsOf('openai', new Headers({ 'x-ratelimit-remaining-requests': 'lots' }))).toEqual([]);
    expect(chatModels('openai', { data: 'none' })).toBeNull();
    expect(chatModels('openai', { data: [{ id: 'whisper-1' }] })).toBeNull();
    expect(chatModels('anthropic', { data: [{ id: 'claude-haiku-5', line: 'haiku', created_at: '2026-09-01T00:00:00Z' }, { id: 'claude-sonnet-5', line: 'sonnet', created_at: '2026-08-01T00:00:00Z' }] }))
      .toEqual({ models: ['claude-haiku-5', 'claude-sonnet-5'], model: 'claude-sonnet-5' });
  });
  it('translates the agent loop’s turns to Anthropic and its answer back', async () => {
    const request = anthropicRequest('claude-sonnet-5', {
      messages: [
        { role: 'system', content: 'Be careful.' }, { role: 'user', content: 'Task' },
        { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'exec', arguments: '{"command":"ls"}' } }] },
        { role: 'tool', tool_call_id: 't1', content: '{"stdout":"a"}' }, { role: 'user', content: 'Continue.' },
      ],
      tools: [{ type: 'function', function: { name: 'exec', description: 'Run', parameters: { type: 'object' } } }],
    });
    expect(request).toMatchObject({ system: 'Be careful.', tool_choice: { disable_parallel_tool_use: true }, tools: [{ name: 'exec', input_schema: { type: 'object' } }] });
    // Models after Claude Opus 4.6 refuse any temperature but the default.
    expect(request).not.toHaveProperty('temperature');
    expect(request.messages.map(item => item.role)).toEqual(['user', 'assistant', 'user']);
    expect(request.messages[1].content).toEqual([{ type: 'tool_use', id: 't1', name: 'exec', input: { command: 'ls' } }]);
    expect(request.messages[2].content).toEqual([{ type: 'tool_result', tool_use_id: 't1', content: '{"stdout":"a"}' }, { type: 'text', text: 'Continue.' }]);

    const seen: Headers[] = [];
    const content = [{ type: 'thinking', thinking: '', signature: 'signed' }, { type: 'text', text: 'Listing.' }, { type: 'tool_use', id: 't2', name: 'exec', input: { command: 'pwd' } }];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      seen.push(new Headers(init.headers));
      return Response.json({ content });
    }));
    const { reply } = await providerCall('anthropic', { key: ANTHROPIC_KEY, model: 'claude-sonnet-5', version: 'v' }, 'claude-sonnet-5', { messages: [{ role: 'user', content: 'Task' }], tools: [] }, AbortSignal.timeout(5000));
    const message = { role: 'assistant', content: 'Listing.', tool_calls: [{ id: 't2', type: 'function', function: { name: 'exec', arguments: '{"command":"pwd"}' } }], anthropic_content: content };
    expect(reply).toEqual({ choices: [{ message }] });
    // The next request echoes that turn as it came, thinking included: Anthropic refuses a rebuilt one.
    const next = anthropicRequest('claude-sonnet-5', { messages: [{ role: 'user', content: 'Task' }, message as never, { role: 'tool', tool_call_id: 't2', content: '{"stdout":"/"}' }], tools: [] });
    expect(next.messages.map(item => item.content)).toEqual([[{ type: 'text', text: 'Task' }], content, [{ type: 'tool_result', tool_use_id: 't2', content: '{"stdout":"/"}' }]]);
    expect(seen[0].get('x-api-key')).toBe(ANTHROPIC_KEY);
    expect(seen[0].get('authorization')).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ unexpected: true })));
    await expect(providerCall('openai', { key: OPENAI_KEY, model: 'gpt-5', version: 'v' }, 'gpt-5', { messages: [{ role: 'user', content: 'Task' }], tools: [] }, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'invalid' });
    await expect(providerCall('openai', { key: OPENAI_KEY, model: 'gpt-5', version: 'v' }, 'gpt-5', { messages: 'nope' }, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: 'invalid' });
  });
});
