import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Change } from '../../../shared/types';
import { reviewComments } from '../../../worker/test/review-comments';

const access = vi.hoisted(() => ({ blocker: null as string | null }));
vi.mock('../../lib/live', () => ({ refreshLive: vi.fn() }));
vi.mock('../../store/workspace', () => ({ useSnapshot: () => null, answerBlocker: () => access.blocker }));
vi.mock('../../lib/router', () => ({ useRoute: () => ({ hash: '' }), paths: { pull: (number: number, options?: { file?: string }) => `/pull/${number}${options?.file ? `/files?file=${encodeURIComponent(options.file)}` : ''}`, code: (path: string) => `/code/${path}` } }));
vi.mock('../ui/Link', () => ({ RouterLink: ({ children, ...props }: React.PropsWithChildren<React.AnchorHTMLAttributes<HTMLAnchorElement>>) => <a {...props}>{children}</a> }));
vi.mock('../code/viewer', async () => ({ Markdown: (await import('../code/markdown')).Markdown }));
vi.mock('./Proof', () => ({ Proof: () => null }));

import { CommentComposer, CommentMarkdown, ReviewThread } from './Comments';
import { Conversation } from './Conversation';
import { Markdown } from '../code/markdown';
const change = { id: 'ch_test', number: 7, revision: 2, comments: reviewComments } as Change;

describe('review conversations', () => {
  it('renders plain feedback without the Markdown chunk', () => {
    expect(renderToStaticMarkup(<CommentMarkdown body="No blocking issues; one suggestion on jitter bounds." />)).toBe('<p>No blocking issues; one suggestion on jitter bounds.</p>');
  });
  it.each([
    '1. Check retries',
    '    const retry = true',
    'See www.example.com',
    'See WWW.example.com',
    'Ask dev@example.com',
    'Keep &amp; decode entities.',
    '**Retry** safely.',
    'First paragraph.\n\nSecond paragraph.',
  ])('preserves Markdown in %s', (body) => {
    expect(renderToStaticMarkup(<CommentMarkdown body={body} />)).toBe(renderToStaticMarkup(<Markdown source={body} path="README.md" landmark={false} />));
  });
  it('renders safe Markdown, model attribution, replies and the exact file link', () => {
    access.blocker = null;
    const html = renderToStaticMarkup(<ReviewThread change={change} root={reviewComments[0]} onUpdated={() => {}} />);
    expect(html).toContain('<strong>empty input</strong>');
    expect(html).toContain('GPT-6 Astra'); expect(html).toContain('for @maya');
    expect(html).toContain('/pull/7/files?file=src%2Fparser.ts#discussion-rc_open');
    expect(html).toContain('Resolve conversation');
    expect(html).not.toContain('Already addressed.');
    expect(html).not.toContain('Preview of');
    expect(html).not.toContain('role="region"');
  });
  it('labels outdated conversations and collapses resolved ones', () => {
    const outdated = renderToStaticMarkup(<ReviewThread change={change} root={reviewComments[3]} inline onUpdated={() => {}} />);
    expect(outdated).toContain('Outdated'); expect(outdated).toContain('src/retry.ts:6');
    expect(outdated).toContain('id="discussion-rc_outdated"');
    const resolved = renderToStaticMarkup(<ReviewThread change={change} root={reviewComments[2]} onUpdated={() => {}} />);
    expect(resolved).toContain('Resolved'); expect(resolved).toContain('Show conversation');
    expect(resolved).not.toContain('Already addressed.');
  });
  it('keeps replies inside their root conversation with one resolve action in the timeline', () => {
    const [root, reply] = reviewComments;
    const pull = { ...change, comments: [root, reply], author: root.author, createdAt: root.createdAt, events: [], reviews: [], summary: 'Check parsing.', intent: '', rationale: '' };
    const html = renderToStaticMarkup(<Conversation change={pull} now={Date.parse(root.createdAt)} />);
    expect(html.match(/class="review-thread"/g)).toHaveLength(1);
    expect(html.match(/Resolve conversation/g)).toHaveLength(1);
    expect(html.match(/I will add the empty-input test\./g)).toHaveLength(1);
    expect(html).toContain('id="comment-rc_open"');
    expect(html).not.toContain('id="comment-rc_reply"');
  });
  it('gives public readers the conversation with disabled write controls', () => {
    access.blocker = 'Only a repository owner can write.';
    const html = renderToStaticMarkup(<ReviewThread change={change} root={reviewComments[0]} onUpdated={() => {}} />);
    expect(html).toContain('Handle'); expect(html.match(/disabled=""/g)).toHaveLength(2);
    access.blocker = null;
  });
  it('offers Comment and Reply with distinct accessible composer labels', () => {
    expect(renderToStaticMarkup(<CommentComposer change={change} onUpdated={() => {}} />)).toContain('aria-label="Add a comment"');
    expect(renderToStaticMarkup(<CommentComposer change={change} inReplyTo="rc_open" onUpdated={() => {}} />)).toContain('aria-label="Reply to conversation"');
    expect(renderToStaticMarkup(<CommentComposer change={change} anchor={{ path: 'src/parser.ts', line: 14, side: 'RIGHT' }} onUpdated={() => {}} />)).toContain('aria-label="Comment on src/parser.ts:14"');
  });
});
