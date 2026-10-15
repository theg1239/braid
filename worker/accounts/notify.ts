import type { NotificationKind } from '../../shared/account';
import type { ChangeSummary } from '../../shared/types';
import { redactPublicText } from '../../shared/privacy';
import { equalSecret, mac } from '../http/auth';
import { HttpError, logFailure } from '../errors';
import { directoryOf, publicOrigin, type BraidEnv } from '../env';
import { notificationUnsubscribe, parse } from '../schemas';

export interface PullRequestNotification {
  /** The Directory workspace id, not its Durable Object name. */
  workspaceId: string;
  kind: NotificationKind;
  change: Pick<ChangeSummary, 'id' | 'number' | 'title' | 'author' | 'label' | 'revision'>;
  reason: string;
}
export interface NotificationItem { number: number; title: string; reason: string; simulated: boolean }
export const NOTIFICATION_DELAY = 60_000;
export const NOTIFICATION_HOURLY_LIMIT = 20;
export const UNSUBSCRIBE_LIFETIME = 90 * 86_400_000;

/** The engine hands off after persisting a transition. Delivery belongs to the Directory's alarm. */
export function notifyPullRequest(env: BraidEnv, ctx: Pick<ExecutionContext, 'waitUntil'>, notification: PullRequestNotification): void {
  if (!env.EMAIL || !env.EMAIL_FROM || notification.workspaceId === 'demo' || notification.workspaceId.startsWith('demo:')) return;
  ctx.waitUntil(directoryOf(env).enqueuePullRequestNotification(notification)
    .catch(error => logFailure('notification_enqueue_failed', error, { changeId: notification.change.id })));
}

async function signature(env: BraidEnv, payload: string): Promise<string> {
  publicOrigin(env);
  return mac(env.SESSION_SECRET, `braid-notification-unsubscribe:v1:${payload}`);
}

/** Only an opaque public person id goes into the link, never an email or email-derived account id. */
export async function unsubscribeToken(env: BraidEnv, person: string, kind: NotificationKind, expires = Date.now() + UNSUBSCRIBE_LIFETIME): Promise<string> {
  const payload = `${person}.${kind}.${expires}`;
  return `${payload}.${await signature(env, payload)}`;
}
export async function verifyUnsubscribeToken(env: BraidEnv, token: unknown): Promise<{ person: string; kind: NotificationKind }> {
  const value = parse(notificationUnsubscribe, token);
  if (value.expires <= Date.now() || value.expires > Date.now() + UNSUBSCRIBE_LIFETIME || !await equalSecret(value.signature, await signature(env, `${value.person}.${value.kind}.${value.expires}`)))
    throw new HttpError(400, 'This unsubscribe link is invalid or expired.');
  return { person: value.person, kind: value.kind };
}

/** Subject lines and reasons are untrusted prose, even after their request shapes were parsed. */
export const notificationText = (value: string, max: number) => redactPublicText(value).replace(/[\s\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max);

export async function sendPullRequestEmail(env: BraidEnv, recipient: { email: string; person: string; owner: string; repo: string }, kind: NotificationKind, items: NotificationItem[]): Promise<void> {
  if (!env.EMAIL || !env.EMAIL_FROM) return;
  const origin = publicOrigin(env);
  const address = `${recipient.owner}/${recipient.repo}`;
  const unsubscribe = new URL('/api/notifications/unsubscribe', origin);
  unsubscribe.searchParams.set('token', await unsubscribeToken(env, recipient.person, kind));
  const subject = items.length === 1 ? `${items[0].title} (#${items[0].number})`
    : `${items.length} pull requests ${kind === 'attention' ? 'need your review' : 'returned to you'}`;
  const text = items.map(item => [
    ...(items.length > 1 ? [`${item.title} (#${item.number})`] : []),
    `${item.simulated ? 'Simulated pull request. ' : ''}${kind === 'attention' ? 'Review required' : 'Changes requested'}: ${item.reason}`,
    new URL(`/${address}/pull/${item.number}`, origin).href,
  ].join('\n')).join('\n\n');
  await env.EMAIL.send({ from: env.EMAIL_FROM, to: recipient.email, subject: `[${address}] ${subject}`,
    text: `${text}\n\nUnsubscribe from ${kind === 'attention' ? 'review requests' : 'returned pull requests'}: ${unsubscribe.href}` });
}
