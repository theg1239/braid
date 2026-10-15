import { Suspense, useEffect, useRef, useState } from 'react';
import { Banner, Button, InputArea } from '@cloudflare/kumo';
import type { Change, ChangeComment, CommentAnchor } from '../../../shared/types';
import { changes, errorMessage } from '../../lib/api';
import { isModifierKey } from '../../lib/format';
import { useIdempotencyKey, useNow } from '../../lib/hooks';
import { refreshLive } from '../../lib/live';
import { paths } from '../../lib/router';
import { answerBlocker, useSnapshot } from '../../store/workspace';
import { Markdown } from '../code/viewer';
import { RouterLink } from '../ui/Link';
import { AuthorChip } from './Bits';
import { RelativeTime } from '../ui/Time';

export function CommentMarkdown({ body, path = 'README.md' }: { body: string; path?: string }) {
  // A single plain paragraph needs no parser or stylesheet before it can be read.
  // Any Markdown delimiter, autolink, list or indentation keeps the full renderer.
  if (!/[\n\r\t\\`*_[\]<>~#&|:@+-]|^ {4}|\bwww\.|^\s*\d+[.)]\s/i.test(body)) return <p>{body}</p>;
  return <Suspense fallback={<p className="review-comment__plain">{body}</p>}><Markdown source={body} path={path} landmark={false} /></Suspense>;
}

/** The same composer handles a conversation, a line comment and a reply; its retry key follows its exact payload. */
export function CommentComposer({ change, onUpdated, anchor, inReplyTo, onCancel, value, onValueChange }: {
  change: Change; onUpdated: (change: Change) => void;
  anchor?: Pick<CommentAnchor, 'path' | 'line' | 'side'>; inReplyTo?: string; onCancel?: () => void;
  value?: string; onValueChange?: (value: string) => void;
}) {
  const snapshot = useSnapshot(), attempt = useIdempotencyKey();
  const blocker = answerBlocker(snapshot);
  const [draft, setDraft] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [revision] = useState(change.revision);
  const stale = !!anchor && revision !== change.revision;
  const body = value ?? draft, setBody = onValueChange ?? setDraft;
  const form = useRef<HTMLFormElement>(null), sending = useRef(false);
  const disabled = !!blocker || stale || busy || !body.trim();
  useEffect(() => {
    if (!anchor && !inReplyTo) return;
    // Pierre attaches the annotation slot after React's autoFocus runs.
    const frame = requestAnimationFrame(() => form.current?.querySelector('textarea')?.focus());
    return () => cancelAnimationFrame(frame);
  }, [anchor?.path, anchor?.line, anchor?.side, inReplyTo]);
  const send = async () => {
    if (disabled || sending.current) return;
    const input = { body: body.trim(), revision: anchor ? revision : change.revision, ...anchor, ...(inReplyTo ? { inReplyTo } : {}) };
    const key = attempt.key(['comment', change.id, input]);
    sending.current = true;
    setBusy(true); setError(null);
    try {
      onUpdated(await changes.comment(change.id, input, key));
      attempt.settle(); setBody(''); onCancel?.(); refreshLive('changes');
    } catch (err) { attempt.settle(err); setError(errorMessage(err)); }
    finally { sending.current = false; setBusy(false); }
  };
  return <form ref={form} className="review-composer" aria-label={inReplyTo ? 'Reply to conversation' : anchor ? `Comment on ${anchor.path}:${anchor.line}` : 'Add a comment'} onSubmit={event => { event.preventDefault(); void send(); }}>
    <InputArea label={inReplyTo ? 'Reply' : 'Add a comment'} placeholder={inReplyTo ? 'Write a reply…' : 'Leave a comment…'} value={body} onValueChange={setBody} autoResize minRows={inReplyTo ? 2 : 3} maxRows={12} maxLength={8000} disabled={!!blocker || busy} onKeyDown={event => {
      if (event.key === 'Enter' && isModifierKey(event) && !event.nativeEvent.isComposing) {
        event.preventDefault();
        if (!disabled) event.currentTarget.form?.requestSubmit();
      }
    }} />
    <div className="review-composer__actions" title={blocker ?? undefined}>
      <span className="quiet">Markdown is supported</span>
      {onCancel ? <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button> : null}
      <Button type="submit" size="sm" variant="secondary" loading={busy} disabled={disabled}>{inReplyTo ? 'Reply' : 'Comment'}</Button>
    </div>
    {error && !blocker ? <Banner variant="error" size="sm" description={error} /> : null}
    {stale ? <Banner variant="alert" size="sm" description="New changes were pushed. Choose a line in the latest changes." /> : null}
  </form>;
}

/** GitHub's review conversation: its original line, replies, and one resolve action. */
export function ReviewThread({ change, root, onUpdated, inline = false }: { change: Change; root: ChangeComment; onUpdated: (change: Change) => void; inline?: boolean }) {
  const snapshot = useSnapshot(), now = useNow(), attempt = useIdempotencyKey();
  const blocker = answerBlocker(snapshot);
  const [reply, setReply] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(!root.resolved);
  const comments = [root, ...(change.comments ?? []).filter(comment => comment.inReplyTo === root.id)];
  const anchor = root.anchor;
  const resolve = async () => {
    const next = !root.resolved, key = attempt.key(['resolve', change.id, root.id, next]);
    setBusy(true); setError(null);
    try { onUpdated(await changes.resolveConversation(change.id, root.id, next, key)); attempt.settle(); setExpanded(!next); }
    catch (err) { attempt.settle(err); setError(errorMessage(err)); }
    finally { setBusy(false); }
  };
  return <article id={`${inline ? 'discussion' : 'comment'}-${root.id}`} className="review-thread" aria-label={anchor ? `Conversation on ${anchor.path}:${anchor.line}` : 'Conversation'} data-resolved={root.resolved || undefined}>
    {anchor || root.resolved ? <header className="review-thread__location">
      {anchor ? <RouterLink href={`${paths.pull(change.number, { file: anchor.path })}#discussion-${root.id}`} className="mono text-link">{anchor.path}:{anchor.position ?? anchor.line}</RouterLink> : <span>Conversation</span>}
      {anchor?.outdated ? <span className="review-thread__state">Outdated</span> : null}
      {root.resolved ? <><span className="review-thread__state">Resolved</span><Button size="sm" variant="ghost" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'Hide conversation' : 'Show conversation'}</Button></> : null}
    </header> : null}
    {expanded ? <>
      {comments.map(comment => <div className="comment review-comment" key={comment.id}>
        <header className="comment__head"><AuthorChip author={comment.author} /><RelativeTime at={comment.createdAt} now={now} className="comment__when" /></header>
        <div className="comment__body"><CommentMarkdown body={comment.body} path={anchor?.path} /></div>
      </div>)}
      <div className="review-thread__actions" title={blocker ?? undefined}>
        <Button size="sm" variant="secondary" disabled={!!blocker || reply} onClick={() => setReply(true)}>Reply</Button>
        <Button size="sm" variant="ghost" disabled={!!blocker || busy} loading={busy} onClick={() => void resolve()}>{root.resolved ? 'Reopen conversation' : 'Resolve conversation'}</Button>
      </div>
      {reply ? <CommentComposer change={change} inReplyTo={root.id} onUpdated={onUpdated} onCancel={() => setReply(false)} /> : null}
    </> : null}
    {error && !blocker ? <Banner variant="error" size="sm" description={error} /> : null}
  </article>;
}
