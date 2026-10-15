import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { textOf } from '../../test/fixtures';
import { Scale } from './Scale';

describe('The hundred-agent queue comparison', () => {
  it('gives the hundred-agent run its measured counts for both queues, with their denominator', () => {
    const words = textOf(renderToStaticMarkup(<Scale />));
    expect(words).toContain('100 agents');
    expect(words).toMatch(/Braid\s+55\s+merged\s+of 100/);
    expect(words).toMatch(/Git queue\s+18\s+merged\s+of 100/);
  });

  it('draws one cell per submitted change, lit only for those that merged', () => {
    const html = renderToStaticMarkup(<Scale />);
    const rows = [...html.matchAll(/<span class="lp-scale__cells" aria-hidden="true">([\s\S]*?)<\/span><\/p>/g)].map((match) => match[1]);
    expect(rows).toHaveLength(2);
    [[100, 55], [100, 18]].forEach(([cells, lit], index) => {
      expect(rows[index].match(/<span[ >]/g)).toHaveLength(cells);
      expect(rows[index].match(/<span data-on="true"><i><\/i><\/span>/g)).toHaveLength(lit);
    });
  });

  it('links to how the run was made instead of a Scripted tag, claiming nothing more', () => {
    const html = renderToStaticMarkup(<Scale />);
    expect(html).toContain('<a class="lp-rec" href="/scale-evidence.txt">Method</a>');
    expect(textOf(html)).not.toMatch(/\bScripted\b|\bSimulated\b/);
    expect(textOf(html)).not.toMatch(/\bAI agents\b|\blive\b|faster|silent wrong|every break/i);
    expect(html).not.toContain('braid-source.zip');
    const method = readFileSync(new URL('../../../public/scale-evidence.txt', import.meta.url), 'utf8');
    expect(method).toContain('## What was measured');
    expect(method).toContain("The agents' edits were scripted");
  });
});
