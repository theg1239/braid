import { organizationWithRepository } from '../test/organization';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountIdentity, OrganizationRole } from '../../shared/account';
import { Directory } from './directory';
import type { BraidEnv } from '../env';
import { notifyPullRequest, NOTIFICATION_DELAY, NOTIFICATION_HOURLY_LIMIT, unsubscribeToken, UNSUBSCRIBE_LIFETIME, verifyUnsubscribeToken, type PullRequestNotification } from './notify';
import { notificationRoute } from './notify-routes';
import { Security } from './security';
import { storageFixture } from '../test/storage';

const alice = { id: 'alice', email: 'alice@example.com', name: 'Alice' };
const bob = { id: 'bob', email: 'bob@example.com', name: 'Bob' };
const eve = { id: 'eve', email: 'eve@example.com', name: 'Eve' };
type Mail = { to: string; from: string; subject: string; text: string };
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-12T10:00:00Z')); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function fixture() {
  const store = storageFixture();
  const send = vi.fn(async (_mail: Mail) => {});
  const env = { EMAIL: { send }, EMAIL_FROM: 'Braid <notifications@braid.example>', PUBLIC_ORIGIN: 'https://braid.example', SESSION_SECRET: 'notification-tests-secret-is-at-least-32-characters' } as unknown as BraidEnv;
  let directory = new Directory(store.ctx, env);
  const security = new Security(storageFixture().ctx, env);
  env.DIRECTORY = { idFromName: (name: string) => name, get: () => directory } as unknown as BraidEnv['DIRECTORY'];
  env.SECURITY = { idFromName: (name: string) => name, get: () => security } as unknown as BraidEnv['SECURITY'];
  const team = organizationWithRepository(directory, alice, 'Acme');
  const workspace = directory.updateWorkspace(alice.id, { teamId: team.id, workspaceId: team.workspaces[0].id, slug: 'relay' });
  const input = (patch: Partial<PullRequestNotification> = {}): PullRequestNotification => ({ workspaceId: workspace.id, kind: 'attention',
    change: { id: 'ch_0000000000001', number: 17, title: 'Protect release configuration', revision: 1, author: { kind: 'agent', id: 'agent:1', name: 'Claude', owner: { id: 'user:alice', name: 'Alice' } } },
    reason: 'Changes to release configuration require an owner.', ...patch });
  return { env, store, send, security, team, workspace, input, current: () => directory,
    restart: () => { directory = new Directory(store.ctx, env); },
    join: async (user: AccountIdentity, role: OrganizationRole) => directory.accept(user, (await directory.invite(alice.id, team.id, { email: user.email, role })).token),
    flush: async () => { const due = await store.storage.getAlarm(); if (due !== null) { vi.setSystemTime(Math.max(Date.now(), due)); await store.storage.deleteAlarm(); await directory.alarm(); } },
  };
}
const tokenIn = (mail: Mail) => new URL(mail.text.match(/https:\/\/[^\s]+\/api\/notifications\/unsubscribe\?token=[^\s]+/)![0]).searchParams.get('token')!;

describe('pull request notifications', () => {
  it('hands off to waitUntil and mails each current repository owner separately after a minute', async () => {
    const f = fixture(); await f.join(bob, 'owner'); await f.join(eve, 'member');
    const background: Promise<unknown>[] = [];
    expect(notifyPullRequest(f.env, { waitUntil: promise => { background.push(promise); } }, f.input())).toBeUndefined();
    expect(background).toHaveLength(1); await Promise.all(background);
    expect(f.send).not.toHaveBeenCalled();
    expect(await f.store.storage.getAlarm()).toBe(Date.now() + NOTIFICATION_DELAY);
    await f.flush();
    expect(f.send.mock.calls.map(([mail]) => mail.to).sort()).toEqual([alice.email, bob.email]);
    for (const [mail] of f.send.mock.calls) {
      expect(mail.subject).toBe('[acme/relay] Protect release configuration (#17)');
      expect(mail.text).toContain('Review required: Changes to release configuration require an owner.\nhttps://braid.example/acme/relay/pull/17');
      expect(mail.text).not.toMatch(/alice@example|bob@example|eve@example/);
      const recipient = mail.to === alice.email ? alice : bob;
      expect(await verifyUnsubscribeToken(f.env, tokenIn(mail))).toEqual({ person: f.current().publicPerson(recipient.id), kind: 'attention' });
    }
  });

  it('returns an agent’s pull request only to its mapped owner, not other owners or a matching display name or email', async () => {
    const f = fixture(); await f.join(bob, 'member');
    const change = { ...f.input().change, author: { ...f.input().change.author, owner: { id: 'user:bob', name: 'Alice', email: alice.email } } };
    await f.current().enqueuePullRequestNotification(f.input({ kind: 'returned', change, reason: 'Add a test for the retry.' }));
    await f.flush();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0][0].to).toBe(bob.email);
    expect(f.send.mock.calls[0][0].text).toContain('Changes requested: Add a test for the retry.');
    f.send.mockClear();
    for (const owner of [undefined, { name: 'Bob', email: bob.email }, { id: 'user:unknown', name: 'Bob' }]) {
      await f.current().enqueuePullRequestNotification(f.input({ kind: 'returned', change: { ...change, id: crypto.randomUUID(), author: { ...change.author, owner } } }));
    }
    await f.flush(); expect(f.send).not.toHaveBeenCalled();
  });

  it('can map an opaque owner id without publishing or guessing an email', async () => {
    const f = fixture(); await f.join(bob, 'member');
    const change = { ...f.input().change, author: { ...f.input().change.author, owner: { publicId: f.current().publicPerson(bob.id), name: 'Bob' } } };
    await f.current().enqueuePullRequestNotification(f.input({ kind: 'returned', change })); await f.flush();
    expect(f.send.mock.calls[0][0].to).toBe(bob.email);
  });

  it('deduplicates concurrent calls and retries across restarts, separately by revision, kind and repository', async () => {
    const f = fixture(), first = f.input();
    await Promise.all([f.current().enqueuePullRequestNotification(first), f.current().enqueuePullRequestNotification(first)]);
    f.restart(); await f.current().enqueuePullRequestNotification(first); await f.flush();
    expect(f.send).toHaveBeenCalledTimes(1);
    await f.current().enqueuePullRequestNotification(first); await f.flush(); expect(f.send).toHaveBeenCalledTimes(1);
    await f.current().enqueuePullRequestNotification(f.input({ change: { ...first.change, revision: 2 } })); await f.flush();
    await f.current().enqueuePullRequestNotification(f.input({ kind: 'returned' })); await f.flush();
    const other = f.current().createWorkspace(alice.id, f.team.id, 'Other');
    await f.current().enqueuePullRequestNotification(f.input({ workspaceId: other.id })); await f.flush();
    expect(f.send).toHaveBeenCalledTimes(4);
  });

  it('batches a minute into one digest per person, kind and repository, using the current address', async () => {
    const f = fixture(); await f.current().enqueuePullRequestNotification(f.input());
    vi.setSystemTime(Date.now() + 45_000);
    await f.current().enqueuePullRequestNotification(f.input({ change: { ...f.input().change, id: 'second', number: 18, title: 'Protect builds' } }));
    f.current().updateWorkspace(alice.id, { teamId: f.team.id, workspaceId: f.workspace.id, slug: 'renamed' });
    await f.flush();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0][0]).toMatchObject({ subject: '[acme/renamed] 2 pull requests need your review' });
    expect(f.send.mock.calls[0][0].text).toContain('Protect release configuration (#17)');
    expect(f.send.mock.calls[0][0].text).toContain('/acme/renamed/pull/18');
  });

  it('limits each person across repositories and kinds, deferring excess mail until their hour resets', async () => {
    const f = fixture(), consume = vi.spyOn(f.security, 'consume');
    for (let i = 0; i <= NOTIFICATION_HOURLY_LIMIT; i++) {
      await f.current().enqueuePullRequestNotification(f.input({ kind: i % 2 ? 'returned' : 'attention', change: { ...f.input().change, id: `change-${i}` } }));
      await f.flush();
    }
    expect(f.send).toHaveBeenCalledTimes(NOTIFICATION_HOURLY_LIMIT);
    expect(consume).toHaveBeenCalledWith('notification:alice', NOTIFICATION_HOURLY_LIMIT, 3_600_000);
    expect(await f.store.storage.getAlarm()).toBeGreaterThan(Date.now());
    const other = organizationWithRepository(f.current(), bob, 'Other');
    await f.current().enqueuePullRequestNotification(f.input({ workspaceId: other.workspaces[0].id })); await f.flush();
    expect(f.send.mock.calls.at(-1)![0].to).toBe(bob.email);
    await f.flush();
    expect(f.send).toHaveBeenCalledTimes(NOTIFICATION_HOURLY_LIMIT + 2);
  });

  it('rechecks preferences, membership and owner role at delivery, including after the budget RPC', async () => {
    const f = fixture(); await f.join(bob, 'owner'); await f.join(eve, 'owner');
    await f.current().enqueuePullRequestNotification(f.input());
    f.current().updateNotificationPreferences(alice, { attention: false });
    f.current().removeMember(alice.id, f.team.id, bob.id);
    vi.spyOn(f.security, 'consume').mockImplementation(async () => {
      f.store.storage.sql.exec("UPDATE members SET role = 'member' WHERE user_id = ?", eve.id);
      return { allowed: true, retryAfter: 0 };
    });
    await f.flush(); expect(f.send).not.toHaveBeenCalled();
  });

  it('retries a failed recipient without resending another recipient’s delivered mail', async () => {
    const f = fixture(); await f.join(bob, 'owner');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    f.send.mockRejectedValueOnce(new Error('Provider unavailable'));
    await f.current().enqueuePullRequestNotification(f.input()); await f.flush();
    const failed = f.send.mock.calls[0][0].to, delivered = f.send.mock.calls[1][0].to;
    f.restart(); await f.flush();
    expect(f.send.mock.calls.map(([mail]) => mail.to)).toEqual([failed, delivered, failed]);
    expect(await f.store.storage.getAlarm()).toBeNull();
  });

  it('redacts addresses and credentials from prose and keeps the subject to one line', async () => {
    const f = fixture();
    await f.current().enqueuePullRequestNotification(f.input({ reason: 'Ask bob@example.com\nUse braid_agent_verysecretconnectiontoken',
      change: { ...f.input().change, title: 'Contact eve@example.com\r\nBcc: alice@example.com\u2028No new lines' } }));
    await f.flush(); const mail = f.send.mock.calls[0][0];
    expect(mail.subject).not.toMatch(/[\r\n\u2028]|@example.com/);
    expect(mail.text).not.toMatch(/@example.com|braid_agent_verysecretconnectiontoken/);
  });

  it('labels simulated live work in the email', async () => {
    const f = fixture();
    await f.current().enqueuePullRequestNotification(f.input({ change: { ...f.input().change, author: { ...f.input().change.author, kind: 'simulated' } } }));
    await f.flush(); expect(f.send.mock.calls[0][0].text).toContain('Simulated pull request.');
  });

  it.each(['demo', 'demo:visitor', 'demo:shared:wnam:123', 'owner-v1'])('never emails the recorded example or an unaddressed workspace: %s', async workspaceId => {
    const f = fixture();
    notifyPullRequest(f.env, f.store.ctx, f.input({ workspaceId })); await f.store.settled();
    await f.current().enqueuePullRequestNotification(f.input({ workspaceId })); await f.flush();
    expect(f.send).not.toHaveBeenCalled(); expect(await f.store.storage.getAlarm()).toBeNull();
  });

  it('is an optional no-op without EMAIL, and contains enqueue failures off the request path', async () => {
    const f = fixture(); delete f.env.EMAIL;
    const waitUntil = vi.fn();
    notifyPullRequest(f.env, { waitUntil }, f.input());
    await f.current().enqueuePullRequestNotification(f.input()); await f.flush();
    expect(waitUntil).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
    f.env.EMAIL = { send: f.send } as unknown as SendEmail;
    vi.spyOn(f.current(), 'enqueuePullRequestNotification').mockRejectedValue(new Error('Unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    notifyPullRequest(f.env, f.store.ctx, f.input()); await f.store.settled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('notification_enqueue_failed'));
  });
});

describe('notification preferences and unsubscribe', () => {
  const request = (path = '/api/notifications', body?: unknown, headers: Record<string, string> = {}) => new Request(`https://braid.example${path}`, body === undefined ? undefined : { method: 'PATCH', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  it('migrates existing people on by default, persists partial writes through restarts, and returns only booleans', async () => {
    const store = storageFixture();
    store.storage.sql.exec('CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL)');
    store.storage.sql.exec('INSERT INTO users VALUES (?, ?, ?)', alice.id, alice.email, alice.name);
    const directory = new Directory(store.ctx, {} as BraidEnv);
    expect(directory.notificationPreferences(alice)).toEqual({ attention: true, returned: true });
    directory.updateNotificationPreferences(alice, { attention: false });
    expect(new Directory(store.ctx, {} as BraidEnv).notificationPreferences(alice)).toEqual({ attention: false, returned: true });
    const f = fixture();
    expect(await (await notificationRoute(request(), f.env, alice)).json()).toEqual({ attention: true, returned: true });
    const result = await notificationRoute(request(undefined, { returned: false }), f.env, alice);
    expect(await result.json()).toEqual({ attention: true, returned: false });
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(f.current().notificationPreferences(bob)).toEqual({ attention: true, returned: true });
  });

  it('requires the person’s session, rejects agents and cross-site writes, and cannot target another user', async () => {
    const f = fixture();
    for (const body of [undefined, { attention: false }]) {
      await expect(notificationRoute(request(undefined, body), f.env, null)).rejects.toMatchObject({ status: 401 });
      await expect(notificationRoute(request(undefined, body), f.env, alice, 'work')).rejects.toMatchObject({ status: 403 });
    }
    await expect(notificationRoute(request(undefined, { attention: false }, { origin: 'https://other.example' }), f.env, alice)).rejects.toMatchObject({ status: 403 });
    await expect(notificationRoute(request(undefined, { attention: false, userId: bob.id }), f.env, alice)).rejects.toMatchObject({ status: 400 });
    for (const body of [{}, { attention: 'false' }, { returned: null }]) await expect(notificationRoute(request(undefined, body), f.env, alice)).rejects.toMatchObject({ status: 400 });
    await expect(notificationRoute(new Request('https://braid.example/api/notifications', { method: 'DELETE' }), f.env, alice)).rejects.toMatchObject({ status: 404 });
    expect(f.current().notificationPreferences(alice)).toEqual({ attention: true, returned: true });
  });

  it('honors both opt-outs without changing the other person or kind', async () => {
    const f = fixture(); await f.join(bob, 'owner');
    f.current().updateNotificationPreferences(alice, { attention: false, returned: false });
    await f.current().enqueuePullRequestNotification(f.input());
    await f.current().enqueuePullRequestNotification(f.input({ kind: 'returned' })); await f.flush();
    expect(f.send.mock.calls.map(([mail]) => mail.to)).toEqual([bob.email]);
  });

  it('unsubscribes with one signed link without a session, idempotently and only for its person and kind', async () => {
    const f = fixture(); await f.join(bob, 'owner');
    const token = await unsubscribeToken(f.env, f.current().publicPerson(alice.id)!, 'returned');
    // A mail scanner opening the link changes nothing; the page's button does.
    const opened = await notificationRoute(request(`/api/notifications/unsubscribe?token=${token}`), f.env, null);
    expect(await opened.text()).toContain('<h1>Turn off returned pull request emails?</h1><form method="post">');
    expect(f.current().notificationPreferences(alice)).toEqual({ attention: true, returned: true });
    for (let i = 0; i < 2; i++) {
      const response = await notificationRoute(new Request(`https://braid.example/api/notifications/unsubscribe?token=${token}`, { method: 'POST' }), f.env, null);
      expect(await response.text()).toContain('<h1>You will get no more returned pull request emails.</h1>');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    }
    expect(f.current().notificationPreferences(alice)).toEqual({ attention: true, returned: false });
    expect(f.current().notificationPreferences(bob)).toEqual({ attention: true, returned: true });
  });

  it('rejects malformed, forged, wrong-kind, wrong-person, expired, and overlong-lived links', async () => {
    const f = fixture(), person = f.current().publicPerson(alice.id)!;
    const token = await unsubscribeToken(f.env, person, 'attention');
    const expired = await unsubscribeToken(f.env, person, 'attention', Date.now());
    const future = await unsubscribeToken(f.env, person, 'attention', Date.now() + UNSUBSCRIBE_LIFETIME + 1);
    const another = f.current().recordPerson(bob.id);
    for (const value of [null, '', 'bad', 'a'.repeat(300), token.slice(0, -1) + (token.endsWith('0') ? '1' : '0'), token.replace('attention', 'returned'), token.replace(person, another), expired, future]) {
      await expect(verifyUnsubscribeToken(f.env, value)).rejects.toMatchObject({ status: 400 });
    }
    vi.setSystemTime(Date.now() + UNSUBSCRIBE_LIFETIME);
    await expect(notificationRoute(request(`/api/notifications/unsubscribe?token=${token}`), f.env, null)).rejects.toMatchObject({ status: 400 });
    expect(f.current().notificationPreferences(alice)).toEqual({ attention: true, returned: true });
  });
});
