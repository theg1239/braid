import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { AuthorChip } from './Bits';

it('shows the owner once beside every model in a combined task author', () => {
  const html = renderToStaticMarkup(<AuthorChip author={{ kind: 'agent', id: 'task:limits', name: 'Claude Opus 5.5, GPT-6.1 Sol and Gemini 3 Pro', owner: { name: 'Maya Chen', github: 'maya-chen' } }} />);
  expect(html).toContain('Claude Opus 5.5, GPT-6.1 Sol and Gemini 3 Pro');
  expect(html.match(/for @maya-chen/g)).toHaveLength(1);
  expect(html).not.toContain('Maya Chen');
});
