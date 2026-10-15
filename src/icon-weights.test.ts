import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseAst } from 'vite';
import { pruneIconWeights } from '../scripts/icon-weights';

const weights = ['bold', 'duotone', 'fill', 'light', 'regular', 'thin'];
const definition = (name: string) => `const ${name} = new Map([${weights.map(weight => `["${weight}", { path: "${name}/${weight} )]\\\"", children: [1, { value: 2 }] }]`).join(',')}]);`;

// Compare exact retained expressions, including all SVG paths, in real package code.
function maps(code: string): Map<string, string>[] {
  const found: Map<string, string>[] = [];
  const walk = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(walk); return; }
    const node = value as Record<string, any>;
    if (node.type === 'NewExpression' && node.callee?.name === 'Map' && node.arguments?.[0]?.type === 'ArrayExpression') {
      const entries = node.arguments[0].elements;
      if (entries.length && entries.every((entry: any) => entry?.type === 'ArrayExpression' && typeof entry.elements[0]?.value === 'string' && weights.includes(entry.elements[0].value))) {
        found.push(new Map(entries.map((entry: any) => [entry.elements[0].value, code.slice(entry.start, entry.end)])));
      }
    }
    for (const child of Object.values(node)) walk(child);
  };
  walk(parseAst(code));
  return found;
}

describe('icon weight pruning', () => {
  it('removes only unused weights from every bundled icon and preserves nested SVG expressions', () => {
    const original = definition('first') + definition('second');
    const trimmed = pruneIconWeights(original)!;
    const before = maps(original);
    const after = maps(trimmed);
    expect(after).toHaveLength(2);
    for (let i = 0; i < after.length; i++) {
      expect([...after[i].keys()]).toEqual(['bold', 'fill', 'regular']);
      for (const [weight, expression] of after[i]) expect(expression).toBe(before[i].get(weight));
    }
  });

  it('leaves unrelated, incomplete and already trimmed maps untouched', () => {
    expect(pruneIconWeights('const cache = new Map([["thin", 1], ["key", 2]]);')).toBeNull();
    expect(pruneIconWeights('const partial = new Map([["thin", 1]]);')).toBeNull();
    expect(pruneIconWeights(pruneIconWeights(definition('icon'))!)).toBeNull();
  });

  it('keeps the original when parsing fails', () => {
    expect(pruneIconWeights(definition('icon') + 'const broken = ;')).toBeNull();
    expect(pruneIconWeights('const broken = new Map([["thin",')).toBeNull();
  });

  it('preserves every used SVG definition in the installed Phosphor and Kumo packages', () => {
    const roots = ['../node_modules/@phosphor-icons/react/dist/defs/', '../node_modules/@cloudflare/kumo/dist/chunks/'].map(path => new URL(path, import.meta.url));
    let checked = 0;
    let bundles = 0;
    for (const root of roots) for (const file of readdirSync(root).filter(name => name.endsWith('.js'))) {
      const original = readFileSync(new URL(file, root), 'utf8');
      if (root.pathname.includes('/kumo/') && !original.includes('@phosphor-icons/react/dist/defs/')) continue;
      const trimmed = pruneIconWeights(original);
      const before = maps(original);
      if (!before.length) continue;
      expect(trimmed, file).not.toBeNull();
      const after = maps(trimmed!);
      expect(after, file).toHaveLength(before.length);
      for (let i = 0; i < before.length; i++) {
        expect([...after[i].keys()].sort(), file).toEqual(['bold', 'fill', 'regular']);
        for (const [weight, expression] of after[i]) expect(expression, `${file}: ${weight}`).toBe(before[i].get(weight));
        checked++;
      }
      if (root.pathname.includes('/kumo/')) bundles++;
    }
    expect(checked).toBeGreaterThan(1000);
    expect(bundles).toBeGreaterThan(0);
  });
});
