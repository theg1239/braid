import type { ChangeComment } from '../../shared/types';

const author: ChangeComment['author'] = { id: 'person:m', name: 'Maya', kind: 'human', owner: { id: 'm', name: 'Maya', github: 'maya' } };
const common = { author, revision: 1, createdAt: '2026-10-12T10:00:00Z' };
export const reviewComments: ChangeComment[] = [
  { ...common, id: 'rc_open', body: 'Handle **empty input** before parsing.', resolved: false,
    anchor: { path: 'src/parser.ts', line: 12, position: 14, side: 'RIGHT', revision: 1, outdated: false } },
  { ...common, id: 'rc_reply', body: 'I will add the empty-input test.', inReplyTo: 'rc_open',
    author: { id: 'agent:g', name: 'GPT-6 Astra', kind: 'agent', owner: { id: 'm', name: 'Maya', github: 'maya' } } },
  { ...common, id: 'rc_done', body: 'Already addressed.', resolved: true },
  { ...common, id: 'rc_outdated', body: 'Keep the retry bounded.', resolved: false,
    anchor: { path: 'src/retry.ts', line: 6, position: null, side: 'LEFT', revision: 1, outdated: true } },
];
