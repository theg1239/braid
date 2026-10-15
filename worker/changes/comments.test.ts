import { afterEach, describe, expect, it } from 'vitest';
import { changeHarness } from '../test/changes-harness';
import { storageFixture } from '../test/storage';
import { publicResponse } from '../http/public-view';
import { ChangeShard, type ChangeContext } from './shard';
import type { Result } from '../errors';
import { changesRoute } from './router';
import { shardOf } from './names';
import { recordedExample } from './demo';
import { parse } from '../schemas';
import { commentBody, moveAnchor, unresolvedComments } from './comments';
import type { BraidEnv } from '../env';

let harness: Awaited<ReturnType<typeof changeHarness>> | undefined;
afterEach(async () => { await harness?.close(); harness = undefined; });
const ok = <T>(result: Result<T>) => { if (!result.ok) throw new Error(`${result.status}: ${result.error}`); return result.data; };
const owner = { kind: 'owner' as const, id: 'user:reviewer', name: 'Maya', owner: { id: 'user:reviewer', name: 'Maya', github: 'maya' } };
const before = 'one\ntwo\nthree\n';

async function setup() {
  harness = await changeHarness();
  const baseCommit = harness.git.commitTree({ 'src/a.ts': before, 'other.txt': 'old\n', '.braid/policy.json': JSON.stringify({ autonomy: 'human', reviewers: 0 }) });
  harness.git.native(['update-ref', 'refs/heads/main', baseCommit]);
  const change = ok(await harness.submit('coder', { title: 'Update a', summary: 'Update a.', baseCommit, taskId: 'task-1', files: [{ path: 'src/a.ts', content: 'one\nTWO\nthree\n' }] }));
  const index = shardOf(change.id)!, shard = harness.shard(index), context = harness.context(owner, index);
  const body = { body: 'Keep the empty input case.', revision: 1, path: 'src/a.ts', line: 2, side: 'RIGHT' as const };
  return { h: harness, baseCommit, change, shard, context, body, index };
}

describe('review conversations on the change shard', () => {
  it('stores Markdown, replies as the model for its owner, counts and journaled retries', async () => {
    const { h, change, shard, context, body, index } = await setup();
    const first = ok(await shard.comment(context, change.id, body, 'comment-request-key-1'));
    const root = first.comments![0];
    expect(root).toMatchObject({ body: body.body, author: { name: 'Maya', owner: { github: 'maya' } }, anchor: { path: body.path, line: 2, position: 2, revision: 1, side: 'RIGHT', outdated: false }, resolved: false });
    expect(ok(await shard.comment(context, change.id, body, 'comment-request-key-1')).comments).toEqual(first.comments);
    expect(await shard.comment(context, change.id, { ...body, body: 'Different text' }, 'comment-request-key-1')).toMatchObject({ ok: false, status: 409 });
    const agent = h.context({ kind: 'agent', id: 'agent:coder', name: 'Private connection label', model: 'gpt-6-astra', owner: { name: 'Dev', github: 'dev' } }, index);
    const reply = { body: 'Handled in `parse()`.', revision: 1, inReplyTo: root.id };
    const answered = ok(await shard.comment(agent, change.id, reply, 'reply-request-key-01'));
    expect(answered.comments![1]).toMatchObject({ inReplyTo: root.id, author: { name: 'GPT-6 Astra', owner: { github: 'dev' } } });
    expect(answered.commentCount).toBe(2);
    expect(shard.list({ limit: 10 }).items[0].commentCount).toBe(2);
    expect(ok(await shard.get(change.id)).comments).toEqual(answered.comments);
    expect(answered).not.toHaveProperty('internal');
    expect(ok(await shard.comment(agent, change.id, reply, 'reply-request-key-01'))).not.toHaveProperty('internal');
  });

  it('keeps concurrent replies and records each key once', async () => {
    const { change, shard, context, body } = await setup();
    const first = ok(await shard.comment(context, change.id, body, 'comment-concurrent-1'));
    const input = { body: 'A reply', revision: 1, inReplyTo: first.comments![0].id };
    await Promise.all(Array.from({ length: 8 }, (_, i) => shard.comment(context, change.id, input, `concurrent-reply-${Math.floor(i / 2)}`)));
    expect(ok(await shard.get(change.id)).comments).toHaveLength(5);
  });

  it('rejects viewers, agent-created roots, agent resolution and replies to replies', async () => {
    const { h, change, shard, context, body, index } = await setup();
    const viewer = h.context({ kind: 'viewer', id: 'member', name: 'Member' }, index);
    expect(await shard.comment(viewer, change.id, body, 'denied-comment-key01')).toMatchObject({ ok: false, status: 403 });
    expect(await shard.comment(h.context('coder', index), change.id, body, 'denied-agent-key-01')).toMatchObject({ ok: false, status: 403 });
    const first = ok(await shard.comment(context, change.id, body, 'allowed-comment-key1'));
    const root = first.comments![0];
    expect(await shard.resolveConversation(h.context('coder', index), change.id, root.id, { resolved: true }, 'denied-resolve-key1')).toMatchObject({ ok: false, status: 403 });
    const reply = ok(await shard.comment(context, change.id, { body: 'Reply', revision: 1, inReplyTo: root.id }, 'allowed-reply-key01')).comments![1];
    expect(await shard.comment(context, change.id, { body: 'Nested', revision: 1, inReplyTo: reply.id }, 'denied-nested-key01')).toMatchObject({ ok: false, status: 404 });
    expect(await shard.comment(context, change.id, { ...body, revision: 2 }, 'denied-revision-01')).toMatchObject({ ok: false, status: 404 });
    expect(await shard.comment(context, change.id, { ...body, line: 100 }, 'denied-line-key-01')).toMatchObject({ ok: false, status: 400 });
  });

  it('preserves anchors over inserted lines, and marks an edited line Outdated across revisions', async () => {
    const { h, baseCommit, change, shard, context, body, index } = await setup();
    await shard.comment(context, change.id, body, 'anchor-comment-key1');
    const revise = (revision: number, content: string) => shard.revise(h.context('coder', index), change.id, { previousRevision: revision, baseCommit, summary: 'Revise.', files: [{ path: body.path, content }] }, `anchor-revision-key${revision}`);
    const shifted = ok(await revise(1, 'zero\none\nTWO\nthree\n'));
    expect(shifted.comments![0].anchor).toMatchObject({ line: 2, position: 3, revision: 1, outdated: false });
    const outdated = ok(await revise(2, 'zero\none\nchanged\nthree\n'));
    expect(outdated.comments![0].anchor).toMatchObject({ line: 2, position: null, revision: 1, outdated: true });
    expect(unresolvedComments(outdated.comments!)).toHaveLength(1);
    expect(ok(await revise(3, 'zero\none\nTWO\nthree\n')).comments![0].anchor?.outdated).toBe(true);
  });

  it('supports deleted-side lines, rejects absent sides and outdates a deleted file', async () => {
    const { h, baseCommit, change, shard, context, body, index } = await setup();
    await shard.comment(context, change.id, { ...body, side: 'LEFT' }, 'left-anchor-key-001');
    await shard.comment(context, change.id, body, 'right-anchor-key001');
    const deleted = ok(await shard.revise(h.context('coder', index), change.id, { previousRevision: 1, baseCommit, summary: 'Remove a.', files: [{ path: body.path, content: null }] }, 'delete-revision-key1'));
    expect(deleted.comments!.map(comment => comment.anchor?.outdated)).toEqual([false, true]);
    expect(await shard.comment(context, change.id, { ...body, revision: 2 }, 'missing-side-key001')).toMatchObject({ ok: false, status: 400 });
  });

  it('resolves and reopens the entire thread idempotently without changing review state', async () => {
    const { change, shard, context, body } = await setup();
    const first = ok(await shard.comment(context, change.id, body, 'resolve-comment-key1'));
    const root = first.comments![0];
    await shard.comment(context, change.id, { body: 'Fixed.', revision: 1, inReplyTo: root.id }, 'resolve-reply-key01');
    const resolved = ok(await shard.resolveConversation(context, change.id, root.id, { resolved: true }, 'resolve-thread-key1'));
    expect(resolved.status).toBe(change.status);
    expect(unresolvedComments(resolved.comments!)).toEqual([]);
    expect(ok(await shard.resolveConversation(context, change.id, root.id, { resolved: true }, 'resolve-thread-key1')).comments).toEqual(resolved.comments);
    expect(unresolvedComments(ok(await shard.resolveConversation(context, change.id, root.id, { resolved: false }, 'reopen-thread-key01')).comments!)).toHaveLength(2);
  });

  it('sends the task back with its unresolved comments, and approvals can carry Markdown', async () => {
    const { h, change, shard, context, body } = await setup();
    await shard.comment(context, change.id, body, 'review-comment-key1');
    const review = { revision: 1, verdict: 'revise', summary: 'Please address the line conversation.' };
    const sent = ok(await shard.review(context, change.id, review, 'review-request-key01'));
    expect(sent.status).toBe('revise');
    expect(sent.comments).toHaveLength(1);
    expect(h.workspace.taskChange).toHaveBeenCalledWith('task-1', expect.objectContaining({ status: 'revise' }));
    expect(ok(await shard.review(context, change.id, review, 'review-request-key01')).reviews).toEqual(sent.reviews);
    const approved = ok(await shard.approve(context, change.id, { revision: 1, body: 'Looks **good**.' }, 'approve-request-key1'));
    expect(approved.reviews.at(-1)).toMatchObject({ verdict: 'approve', summary: 'Looks **good**.', author: { name: 'Maya' } });
    expect(ok(await shard.approve(context, change.id, { revision: 1, body: 'Looks **good**.' }, 'approve-request-key1')).reviews).toEqual(approved.reviews);
  });

  it('serves public comments as redacted metadata, with no private author or resolution identity', async () => {
    const { h, change, shard, context, body } = await setup();
    const token = `ghp_${'A1b2'.repeat(9)}`;
    const first = ok(await shard.comment(context, change.id, { ...body, body: `Use **constant time**. Contact reviewer@example.test. ${token}` }, 'public-comment-key1'));
    const resolved = ok(await shard.resolveConversation(context, change.id, first.comments![0].id, { resolved: true }, 'public-resolve-key1'));
    const response = await publicResponse(Response.json(resolved), `/api/changes/${change.id}`, h.env);
    const value = await response.text();
    expect(value).toContain('**constant time**');
    expect(value).not.toContain(token); expect(value).not.toContain('reviewer@example.test'); expect(value).not.toContain('user:reviewer');
    expect(JSON.parse(value).comments[0].anchor.path).toBe(body.path);
  });

  it('enforces gateway permissions, methods, work scope and required request keys', async () => {
    const { h, change, context } = await setup();
    const path = `https://braid.example/api/changes/${change.id}/comments`;
    const input = { body: 'Conversation', revision: 1 };
    const request = (key?: string) => new Request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) }, body: JSON.stringify(input) });
    const gateway = { repository: h.repository, mode: 'live' as const, role: 'owner' as const, person: { id: 'reviewer', name: context.actor.name } };
    await expect(changesRoute(request(), h.env, gateway)).rejects.toMatchObject({ status: 400 });
    await expect(changesRoute(request('gateway-request-key1'), h.env, { ...gateway, role: 'viewer' })).rejects.toMatchObject({ status: 403 });
    await expect(changesRoute(request('gateway-request-key1'), h.env, { ...gateway, agent: { id: 'a', label: 'Agent', scope: 'setup' } })).rejects.toMatchObject({ status: 403 });
    const written = await changesRoute(request('gateway-request-key1'), h.env, gateway);
    expect(written?.status).toBe(201);
    const read = await changesRoute(new Request(path), h.env, { ...gateway, role: 'viewer', publicViewer: true });
    expect(await read?.json()).toHaveLength(1);
  });
});

describe('example comments', () => {
  it('persists visitor threads across object instances without changing the recording or another visitor', async () => {
    const example = await recordedExample(), change = example.change('22');
    expect(change.comments).toHaveLength(2);
    const db = storageFixture(), env = {} as BraidEnv;
    const context: ChangeContext = { repository: 'demo:visitor', shard: 0, actor: { kind: 'owner', id: 'example-visitor', name: 'You' } };
    const shard = new ChangeShard(db.ctx, env);
    const written = ok(await shard.comment(context, change.id, { revision: change.revision, body: 'Please add a case for uppercase schemes.' }, 'example-comment-key1', change));
    const restored = new ChangeShard(db.ctx, env);
    expect(restored.exampleComments([change.id])[change.id]).toEqual(written.comments);
    expect(example.change('22').comments).toHaveLength(2);
    const otherDb = storageFixture();
    expect(new ChangeShard(otherDb.ctx, env).exampleComments([change.id])).toEqual({});
    expect(example.change('22').number).toBe(22);
    db.db.close(); otherDb.db.close();
  });

  it('forgets a visitor\u2019s threads when their copy is reset, and only for copies of the example', async () => {
    const example = await recordedExample(), change = example.change('22');
    const db = storageFixture(), env = {} as BraidEnv;
    const context: ChangeContext = { repository: 'demo:visitor', shard: 0, actor: { kind: 'owner', id: 'example-visitor', name: 'You' } };
    const shard = new ChangeShard(db.ctx, env);
    ok(await shard.comment(context, change.id, { revision: change.revision, body: 'Reset should clear this.' }, 'example-comment-reset1', change));
    expect(shard.exampleComments([change.id])[change.id]).toHaveLength(3);
    expect(() => shard.resetExample('team:t:repository:w')).toThrow('Only a copy of the recorded example can be reset.');
    shard.resetExample('demo:visitor');
    expect(shard.exampleComments([change.id])).toEqual({});
    // The same request key works again after the reset rather than answering from the old receipt.
    const again = ok(await shard.comment(context, change.id, { revision: change.revision, body: 'Reset should clear this.' }, 'example-comment-reset1', change));
    expect(again.comments).toHaveLength(3);
    db.db.close();
  });
});

describe('comment boundaries', () => {
  it.each([{ body: '', revision: 1 }, { body: 'hello', revision: 0 }, { body: 'hello', revision: 1, path: 'x' }, { body: 'hello', revision: 1, line: 1 }])('rejects malformed input %j', input => {
    expect(() => parse(commentBody, input)).toThrow();
  });
  it('handles unchanged CRLF lines and a missing final newline', () => {
    expect(moveAnchor({ path: 'x', line: 2, side: 'RIGHT', revision: 1, position: 2, outdated: false }, 'one\r\ntwo', 'zero\r\none\r\ntwo').position).toBe(3);
  });
});
