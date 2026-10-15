import { describe, expect, it } from 'vitest';
import { parseSearch, qualifierValues, searchFileFilter } from './search-query';

describe('code search query', () => {
  it('parses owners, repositories, paths, languages and exact phrases with their source offsets', () => {
    const source = 'repo:Acme/API org:acme user:maya path:"src/my dir/**" language:"C++" "Hello World" export';
    const query = parseSearch(source);
    expect(query.error).toBeNull();
    expect(query.terms).toEqual(['Hello World', 'export']);
    expect(query.qualifiers.map(q => [q.kind, q.value])).toEqual([['repo', 'acme/api'], ['org', 'acme'], ['user', 'maya'], ['path', 'src/my dir/**'], ['language', 'c++']]);
    expect(source.slice(query.qualifiers[3].start, query.qualifiers[3].end)).toBe('path:"src/my dir/**"');
  });
  it('keeps punctuation, unknown qualifiers and escaped quotes literal', () => {
    expect(parseSearch('a.[b] $dollar \\ http://host "say \\"hi\\"" "repo:acme/api"').terms).toEqual(['a.[b]', '$dollar', '\\', 'http://host', 'say "hi"', 'repo:acme/api']);
  });
  it.each(['', '   ', 'repo:', 'repo:only-owner', 'org:with/slash', 'user:../private', '"unclosed', 'path:"unclosed', '""'])('rejects incomplete syntax: %s', query => {
    expect(parseSearch(query).error).not.toBeNull();
  });
  it('supports repeated qualifiers, any one value per kind and all kinds together', () => {
    const query = parseSearch('path:src/ path:test/ language:TS language:python');
    expect(qualifierValues(query, 'path')).toEqual(['src/', 'test/']);
    const matches = searchFileFilter(query);
    expect(['src/App.tsx', 'test/app.py', 'test/app.js', 'other/App.ts'].filter(matches)).toEqual(['src/App.tsx', 'test/app.py']);
  });
  it.each([
    ['path:src/del', ['src/delivery.ts', 'src/delivery/index.ts']],
    ['path:src/*.ts', ['src/delivery.ts']],
    ['path:src/**/*.ts', ['src/delivery.ts', 'src/delivery/index.ts']],
    ['path:*.ts', ['src/delivery.ts', 'src/delivery/index.ts', 'test/delivery.ts']],
    ['path:src/deliver?.ts', ['src/delivery.ts']],
    ['language:javascript', ['index.mjs']],
    ['language:unknown', []],
  ])('filters %s', (query, expected) => {
    expect(['src/delivery.ts', 'src/delivery/index.ts', 'src/App.tsx', 'test/delivery.ts', 'index.mjs'].filter(searchFileFilter(parseSearch(query)))).toEqual(expected);
  });
  it('keeps pathological wildcard input bounded', () => {
    const matches = searchFileFilter(parseSearch(`path:${'**/'.repeat(70)}missing.ts`));
    expect(matches(`${'x/'.repeat(100)}file.ts`)).toBe(false);
  });
});
