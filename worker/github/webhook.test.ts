import { createHmac } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { storageFixture } from '../test/storage';
import { trunkName } from '../changes/names';
import { GitHubRepo, githubWebhook } from './webhook';

const fixtures: ReturnType<typeof storageFixture>[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const fixture of fixtures.splice(0)) fixture.db.close(); });

function hub(githubEvent: (repository: string) => Promise<void>) {
  const fixture = storageFixture(); fixtures.push(fixture);
  const env = { GITHUB_APP_WEBHOOK_SECRET: 'webhook-secret',
    TRUNKS: { getByName: (name: string) => ({ githubEvent: (repository: string) => { expect(name).toBe(trunkName(repository)); return githubEvent(repository); } }) } } as never;
  const repo = new GitHubRepo(fixture.ctx, env);
  Object.assign(env, { GITHUB_REPOS: { getByName: () => repo } });
  const send = (body: Uint8Array<ArrayBuffer>, delivery: string) => githubWebhook(new Request('https://braid.example/api/github/webhook', { method: 'POST', body,
    headers: { 'x-github-event': 'check_suite', 'x-github-delivery': delivery, 'x-hub-signature-256': `sha256=${createHmac('sha256', 'webhook-secret').update(body).digest('hex')}` } }), env);
  return { repo, send };
}
const suite = (extra = '') => `{"action":"completed","repository":{"id":99},"check_suite":{"head_sha":"${'a'.repeat(40)}","pull_requests":[]}${extra}}`;

it('verifies the signature over the bytes GitHub sent, including a byte-order mark and bytes that are not UTF-8', async () => {
  const woken: string[] = [];
  const { repo, send } = hub(async repository => { woken.push(repository); });
  repo.link('team:t:repository:w');
  // A byte-order mark, and 0xff in place of the `?`: decoding and re-encoding the text would change both.
  const body = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(suite(',"note":"?"')).map(byte => byte === 0x3f ? 0xff : byte)]);
  const answer = await send(body, 'raw-bytes');
  expect(answer.status).toBe(202);
  expect(woken).toEqual(['team:t:repository:w']);
});

it('logs a linked repository that could not take an event by its typed fields, and still wakes the others', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const woken: string[] = [];
  const { repo, send } = hub(async repository => {
    if (repository.endsWith(':broken')) throw new Error('private upstream text');
    woken.push(repository);
  });
  repo.link('team:t:repository:broken'); repo.link('team:t:repository:w');
  const answer = await send(new TextEncoder().encode(suite()), 'fan-out');
  expect(await answer.json()).toMatchObject({ accepted: true, duplicate: false, repositories: 2 });
  expect(woken).toEqual(['team:t:repository:w']);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(warn.mock.calls[0][0]))).toEqual({ event: 'github_event_failed', repository: 'team:t:repository:broken', delivery: 'fan-out', githubEvent: 'check_suite', error: 'Error' });
});
