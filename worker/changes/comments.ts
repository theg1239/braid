import * as v from 'valibot';
import type { ChangeAuthor, ChangeComment, CommentAnchor } from '../../shared/types';
import { diffLines, splitLines } from '../../shared/diff';
import { HttpError } from '../errors';
import { body, text, optionalText } from '../schemas';
import { now } from '../workspace/domain';

const positive = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(Number.MAX_SAFE_INTEGER));
export const commentId = v.pipe(v.string(), v.regex(/^rc_[a-zA-Z0-9_-]{1,80}$/, 'Choose a review comment.'));
export const commentBody = v.pipe(body({
  body: text('Comment', 8000), revision: positive,
  inReplyTo: v.optional(commentId),
  path: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(1024))),
  line: v.optional(positive), side: v.optional(v.picklist(['LEFT', 'RIGHT'])),
}, 'Send a comment and its revision.'), v.check(input =>
  input.path === undefined ? input.line === undefined && input.side === undefined
    : input.line !== undefined && input.side !== undefined && input.inReplyTo === undefined,
'A line comment needs a file, line and side. A reply names its conversation instead.'));
type CommentInput = v.InferOutput<typeof commentBody>;
export const resolveBody = body({ resolved: v.boolean('Choose whether the conversation is resolved.') }, 'Choose whether the conversation is resolved.');
export const approvalWithComment = body({ revision: positive, body: optionalText('Comment', 8000) }, 'Send the revision you approve.');

/** Only unchanged lines survive a revision. The original location never changes. */
export function moveAnchor(anchor: CommentAnchor, before: string | null, after: string | null): CommentAnchor {
  if (anchor.outdated) return anchor;
  const position = before !== null && after !== null
    ? diffLines(before, after).find(op => op.before === anchor.position && op.type === 'equal')?.after ?? null : null;
  return { ...anchor, position, outdated: position === null };
}

export function addComment(comments: ChangeComment[], input: CommentInput, author: ChangeAuthor, revision: number, contents?: string | null): ChangeComment[] {
  if (input.revision !== revision) throw new HttpError(409, `Comment on revision ${revision}, the current revision.`);
  if (comments.length >= 1000 || comments.reduce((size, comment) => size + comment.body.length, input.body.length) > 256_000)
    throw new HttpError(409, 'This pull request has reached its comment limit.');
  const root = input.inReplyTo ? comments.find(comment => comment.id === input.inReplyTo) : undefined;
  if (input.inReplyTo && (!root || root.inReplyTo)) throw new HttpError(404, 'Conversation not found.');
  let anchor: CommentAnchor | undefined;
  if (input.path !== undefined) {
    const lines = splitLines(contents ?? '').length;
    if (input.line! > lines) throw new HttpError(400, 'Choose a line that exists on that side of the file.');
    anchor = { path: input.path, line: input.line!, side: input.side!, revision, position: input.line!, outdated: false };
  }
  return [...comments, { id: `rc_${crypto.randomUUID()}`, body: input.body, author, createdAt: now(), revision,
    ...(root ? { inReplyTo: root.id } : { resolved: false }), ...(anchor ? { anchor } : {}) }];
}

export function resolveComment(comments: ChangeComment[], id: string, resolved: boolean, author: ChangeAuthor): ChangeComment[] {
  const root = comments.find(comment => comment.id === id && !comment.inReplyTo);
  if (!root) throw new HttpError(404, 'Conversation not found.');
  return comments.map(comment => comment.id === id ? { ...comment, resolved, resolvedBy: { author }, resolvedAt: now() } : comment);
}

/** All replies stay with unresolved roots, including conversations whose original line is outdated. */
export function unresolvedComments(comments: ChangeComment[]): ChangeComment[] {
  const roots = new Set(comments.filter(comment => !comment.inReplyTo && !comment.resolved).map(comment => comment.id));
  return comments.filter(comment => roots.has(comment.inReplyTo ?? comment.id));
}

export function reviewCommentText(comments: ChangeComment[]): string {
  return comments.map(comment => {
    const anchor = comment.anchor, owner = comment.author.owner;
    const name = `${comment.author.name}${comment.author.kind === 'agent' && owner ? ` for ${owner.github ? `@${owner.github}` : owner.name}` : ''}`;
    const heading = comment.inReplyTo ? `Reply to ${comment.inReplyTo}` : `Comment ${comment.id}${comment.resolved ? ' (Resolved)' : ''}`;
    const where = anchor ? ` at ${anchor.path}:${anchor.position ?? anchor.line} (${anchor.side}${anchor.outdated ? ', Outdated' : ''}; revision ${anchor.revision})` : '';
    return `${heading}${where} by ${name}:\n${comment.body}`;
  }).join('\n\n');
}
