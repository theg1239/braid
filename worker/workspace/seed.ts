import type { Agent, Capabilities, ContextItem, Mission, WorkspaceSnapshot } from '../../shared/types';
import { change, detectCollisions, now } from './domain';
import { exampleMain } from '../changes/demo';
import { modelName } from '../../shared/provenance';

export const BASE_FILES: Record<string, string> = {
  'README.md': '# Relay · a tiny webhook service\n\nA Workers-native webhook delivery example.\n\n## Delivery\n\nPOST an event to a configured HTTPS endpoint. Delivery currently makes one attempt.\n',
  'AGENTS.md': '# Working agreements\n\nKeep the delivery interface small. Never log signing secrets. Do not retry client errors. All changes must include a rationale and disclose checks that were not run.\n',
  'src/delivery.ts': `export interface DeliveryResult {
  ok: boolean;
  status: number;
  attempts: number;
}

export async function deliver(
  url: string,
  body: string,
): Promise<DeliveryResult> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  return { ok: response.ok, status: response.status, attempts: 1 };
}
`,
  'src/index.ts': `import { deliver } from './delivery';

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Relay webhook service');
    }
    return Response.json({ message: 'Configure a delivery destination first.' }, { status: 400 });
  },
};
`,
  'package.json': JSON.stringify({ name: 'relay-webhooks', private: true, type: 'module', scripts: { typecheck: 'tsc --noEmit' }, devDependencies: { typescript: '^7.0.2' } }, null, 2) + '\n',
  'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', lib: ['ES2022', 'DOM'], moduleResolution: 'Bundler', strict: true, noEmit: true }, include: ['src'] }, null, 2) + '\n',
};
/** The reliability lane: wait for a free slot, so every delivery still goes out. */
const waitingLimiter = `/** At most ten deliveries per second to each endpoint host; callers wait for a free slot. */
const RATE = 10;
const buckets = new Map<string, { tokens: number; updated: number }>();

export async function acquire(url: string): Promise<void> {
  const host = new URL(url).host;
  for (;;) {
    const now = Date.now();
    const bucket = buckets.get(host) ?? { tokens: RATE, updated: now };
    bucket.tokens = Math.min(RATE, bucket.tokens + ((now - bucket.updated) / 1000) * RATE);
    bucket.updated = now;
    buckets.set(host, bucket);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return;
    }
    await new Promise(resolve => setTimeout(resolve, ((1 - bucket.tokens) / RATE) * 1000));
  }
}
`;
/** The security lane: refuse attempts past the limit, so a busy receiver is never flooded; the retry loop sends them later. */
const failingLimiter = `/** At most ten deliveries to each endpoint host per second; attempts past the limit fail fast and are retried later. */
const LIMIT = 10;
const windows = new Map<string, { start: number; count: number }>();

export class RateLimited extends Error {
  constructor(readonly host: string) {
    super(\`Too many deliveries to \${host}; retrying later.\`);
  }
}

export async function acquire(url: string): Promise<void> {
  const host = new URL(url).host;
  const now = Date.now();
  const window = windows.get(host);
  if (!window || now - window.start >= 1000) {
    windows.set(host, { start: now, count: 1 });
    return;
  }
  if (window.count >= LIMIT) throw new RateLimited(host);
  window.count += 1;
}
`;
/** Both implementations call the limiter the same way before each attempt. */
function limitedDelivery(delivery: string | undefined): string | undefined {
  if (!delivery || delivery.includes('acquire(')) return undefined;
  const next = delivery.replace("import { sign } from './signature';\n", "import { acquire } from './limits';\nimport { sign } from './signature';\n")
    .replace('    try {\n      const response = await fetch(url, {', '    try {\n      await acquire(url);\n      const response = await fetch(url, {');
  return next.includes("from './limits'") && next.includes('await acquire(url);') ? next : undefined;
}
const RECEIVER_LIMITS = '\n## Rate limits\n\nRelay sends at most ten deliveries per second to each endpoint host, so size a receiver for short bursts at that rate. Deliveries past the limit are delayed or retried, never dropped silently.\n';
/**
 * A task's three lanes. Agents go by their model, never an invented name: the recorded example's lanes are three
 * models, and hosted lanes are renamed for the model that runs them.
 */
export function agents(): Agent[] {
  return [
    { id: 'atlas', name: modelName('claude-opus-5-5'), model: 'claude-opus-5-5', role: 'Reliability', color: '#2E63C9', task: 'Complete the task with an emphasis on correct behavior, bounded retries, and graceful failure. Write the implementation files.', scope: ['src/', 'test/', 'tests/'] },
    { id: 'sable', name: modelName('gpt-6.1-sol'), model: 'gpt-6.1-sol', role: 'Security', color: '#17877A', task: 'Independently implement the sensitive parts of the task with strict input validation and fail-closed behavior. Offer a safer alternative where it conflicts with the reliability implementation.', scope: ['src/', 'test/', 'tests/'] },
    { id: 'reed', name: modelName('gemini-3-pro'), model: 'gemini-3-pro', role: 'Developer experience', color: '#5C7D22', task: 'Write documentation and usage examples for the task. Keep contracts accurate, explain tradeoffs, and never claim tests ran.', scope: ['README.md', 'docs/', 'examples/'] },
  ].map(a => ({ ...a, status: 'queued', summary: '', rationale: '', checks: [], changes: [] } as Agent));
}
/**
 * The recorded example's sample task, written against whatever main currently
 * holds: the reliability and security lanes each add a per-endpoint limiter and
 * disagree about what happens past the limit, and the third documents it.
 */
export function fillDemoAgent(agent: Agent, base: Record<string, string>): Agent {
  const delivery = limitedDelivery(base['src/delivery.ts']);
  const files: Record<string, string> = agent.id === 'atlas' ? { 'src/limits.ts': waitingLimiter, ...(delivery ? { 'src/delivery.ts': delivery } : {}) }
    : agent.id === 'sable' ? { 'src/limits.ts': failingLimiter, ...(delivery ? { 'src/delivery.ts': delivery } : {}) }
    : { 'docs/receivers.md': `${(base['docs/receivers.md'] ?? '# Receiving Relay webhooks\n').replace(RECEIVER_LIMITS, '')}${RECEIVER_LIMITS}` };
  const summary = agent.id === 'atlas' ? 'Waits for a free slot, so every delivery still goes out at no more than ten per second per endpoint.'
    : agent.id === 'sable' ? 'Fails fast past ten deliveries per second per endpoint, so a busy receiver is never flooded; the retry loop sends them later.'
    : 'Documents the per-endpoint limit for teams receiving Relay webhooks.';
  const rationale = agent.id === 'atlas'
    ? 'A briefly busy receiver should still get every event without Relay giving up on it. Waiting costs Worker time during bursts, and the existing retry budget bounds how long one delivery can take.'
    : agent.id === 'sable'
    ? 'Waiting inside a Worker holds its resources while a receiver is overloaded. Failing fast keeps Relay predictable under load, and the existing retries and signed, idempotent requests make a later attempt safe. Which behavior is right is a product decision.'
    : 'Receivers need the limit to size their capacity. What happens past it depends on the implementation chosen in review, so the documentation only promises that nothing is dropped silently.';
  return { ...agent, status: 'review', summary, rationale, changes: Object.entries(files).filter(([path, content]) => content !== base[path]).map(([path, content]) => change(path, base[path] ?? '', content)), commit: agent.id === 'atlas' ? 'a47d91bc628ce938ac3f27dde081a390dcf4b720' : agent.id === 'sable' ? 'e91a472cd3c59cb8c094b0022bc9ee771a4d6ce1' : 'bc73a290d6e04ac23efb891c04dcea92b28f013a', repo: `relay-${agent.model}`, completedAt: now(), owner: { name: 'Maya Chen', github: 'maya-chen' },
    checks: [
      { label: 'Sample patch', status: 'passed', detail: 'Recorded example output; this simulated agent did not call a model.' },
      { kind: 'runtime', label: 'Runtime tests', status: 'warning', detail: 'Not run in the recorded example. Review and test before production use.' },
    ],
  };
}
function initialContext(): ContextItem[] {
  const createdAt = now();
  return [
    { id: 'ctx-1', title: 'Never retry permanent client errors', body: 'Retry network failures, HTTP 429 and 5xx responses only. Authentication and validation failures must return immediately.', kind: 'constraint', author: 'You', createdAt },
    { id: 'ctx-2', title: 'An event keeps its identity', body: 'Use one idempotency key across every attempt. Receivers must be able to deduplicate without relying on delivery order.', kind: 'constraint', author: 'You', createdAt },
    { id: 'ctx-3', title: 'Keep the reason with the code', body: 'Every agent preserves its context. Human decisions are committed with the merged code, so the next agent can recover the intent.', kind: 'learning', author: 'Braid', createdAt },
  ];
}
export function seedWorkspace(mode: 'demo' | 'live', capabilities: Capabilities): WorkspaceSnapshot {
  const description = 'A Workers-native webhook delivery service', stack = ['TypeScript', 'Workers', 'Artifacts'];
  if (mode === 'live') return { project: { id: '', name: 'Your workspace', description, branch: 'main', head: '', stack }, missions: [], context: [], files: {}, capabilities, activity: [] };
  // The example's repository is main as the recorded run left it, so Code, Changes and this task share one history.
  const createdAt = now(), main = exampleMain();
  const mission: Mission = {
    id: 'task-limits', title: 'Limit deliveries per endpoint',
    intent: 'Keep Relay from overwhelming a busy receiver: at most ten deliveries per second to each endpoint host, and nothing dropped silently.',
    status: 'review', source: 'demo', execution: 'cloud', createdAt, baseCommit: main.head,
    agents: agents().map(a => fillDemoAgent({ ...a, startedAt: createdAt }, main.files)), collisions: [],
  };
  mission.collisions = detectCollisions(mission.agents);
  return {
    project: { id: 'relay', name: 'relay', description, branch: 'main', head: main.head, stack },
    missions: [mission], context: initialContext(), files: { ...main.files }, capabilities,
    activity: [
      { id: 'evt-6', type: 'conflict', message: 'Two approaches, one decision', detail: `${mission.agents[0].name} and ${mission.agents[1].name} both wrote src/limits.ts. Choose what Relay does past the limit.`, timestamp: createdAt, missionId: mission.id },
      ...mission.agents.map((a, i) => ({ id: `evt-${i + 2}`, type: 'change' as const, message: `${a.name} submitted a proposal`, detail: a.summary, timestamp: createdAt, agentId: a.id, missionId: mission.id })),
      { id: 'evt-1', type: 'fork', message: 'Started 3 agents', detail: 'Recorded example · every agent starts from main', timestamp: createdAt, missionId: mission.id },
    ],
  };
}
