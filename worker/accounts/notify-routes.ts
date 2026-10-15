import type { AccountIdentity } from '../../shared/account';
import type { AgentScope } from '../../shared/types';
import { assertOrigin, jsonBody } from '../http/auth';
import { HttpError } from '../errors';
import { directoryOf, type BraidEnv } from '../env';
import { verifyUnsubscribeToken } from './notify';
import { notificationPreferences, parse } from '../schemas';

/** Account routes run before repository authorization; a signed link needs no browser session. */
export async function notificationRoute(request: Request, env: BraidEnv, user: AccountIdentity | null, agentScope?: AgentScope): Promise<Response> {
  const url = new URL(request.url);
  const directory = directoryOf(env);
  if (url.pathname === '/api/notifications/unsubscribe' && ['GET', 'POST'].includes(request.method)) {
    const { person, kind } = await verifyUnsubscribeToken(env, url.searchParams.get('token'));
    const emails = kind === 'attention' ? 'review request emails' : 'returned pull request emails';
    // Mail scanners open links before people do, so opening the link only asks; the button turns the emails off.
    if (request.method === 'POST') { assertOrigin(request); await directory.unsubscribeNotifications(person, kind); }
    const body = request.method === 'POST' ? `<h1>You will get no more ${emails}.</h1><p>Turn them back on in Settings → Account.</p>` : `<h1>Turn off ${emails}?</h1><form method="post"><button>Turn off</button></form>`;
    return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="dark light"><title>Braid notifications</title>${body}`, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
    });
  }
  if (url.pathname !== '/api/notifications' || !['GET', 'PATCH'].includes(request.method)) throw new HttpError(404, 'Notification endpoint not found.');
  if (!user) throw new HttpError(401, 'Sign in to manage your notifications.');
  if (agentScope) throw new HttpError(403, 'Manage notification preferences in Braid.');
  if (request.method === 'PATCH') assertOrigin(request);
  const preferences = request.method === 'GET' ? await directory.notificationPreferences(user)
    : await directory.updateNotificationPreferences(user, parse(notificationPreferences, await jsonBody(request)));
  return Response.json(preferences, { headers: { 'cache-control': 'no-store' } });
}
