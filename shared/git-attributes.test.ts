import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { explicitGuideAttributes } from './git-attributes';
import type { GuideFileAttributes } from './guide';

const folders: string[] = [];
afterEach(() => folders.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
describe('explicit Git attributes only', () => {
  it('never infers categories from file names, extensions or content', () => {
    expect(explicitGuideAttributes(['package-lock.json', 'dist/output.min.js', '__snapshots__/x.snap', 'docs/a.md', 'a.test.ts', '.braid/missions/a.json'], [])).toEqual([]);
  });
  it('honors directory precedence, explicit false, resets, quoted paths and macros', () => {
    expect(explicitGuideAttributes(['src/a.ts', 'src/b.ts', 'src/c.ts', 'space here.ts', 'vendor/lib.ts'], [
      { path: '.gitattributes', content: '[attr]bundle linguist-generated linguist-vendored\n*.ts linguist-generated\n"space here.ts" -linguist-generated\nvendor/** bundle\n' },
      { path: 'src/.gitattributes', content: 'a.ts !linguist-generated\nb.ts linguist-generated=false\nc.ts linguist-vendored=true\n' },
    ])).toEqual([{ path: 'src/b.ts', generated: false }, { path: 'src/c.ts', generated: true, vendored: true }, { path: 'space here.ts', generated: false }, { path: 'vendor/lib.ts', generated: true, vendored: true }]);
  });
  it('bounds recursive macro expansion instead of multiplying attacker-controlled input', () => {
    const macros = Array.from({ length: 9 }, (_, i) => `[attr]m${i} m${i + 1} m${i + 1} m${i + 1}`).join('\n');
    expect(() => explicitGuideAttributes(['a.ts'], [{ path: '.gitattributes', content: `${macros}\n[attr]m9 linguist-generated\n*.ts m0\n` }])).toThrow(/expansion limit/);
  });
  it('matches Git check-attr across a repository path corpus and generated patterns', () => {
    const root = mkdtempSync(join(tmpdir(), 'braid-attrs-')); folders.push(root);
    execFileSync('git', ['init', '-q', root]);
    const paths = execFileSync('rg', ['--files', 'shared', 'worker/changes', 'src/components/pulls'], { encoding: 'utf8' }).trim().split('\n').slice(0, 100);
    paths.push('a.ts', 'xa.ts', 'one/a.ts', 'one/two/a.ts', 'one/a.ts/child', 'space here.ts', 'literal{a,b}.ts');
    const patterns = ['*.ts', 'worker/**', 'worker/*', '**/a.ts', 'one/**/a.ts', 'one/', 'shared/[a-z]*.ts', 'shared/guide.?s', '/a.ts', 'literal{a,b}.ts', '"space here.ts"'];
    let comparisons = 0;
    for (const pattern of patterns) {
      const content = `${pattern} linguist-generated\n`;
      writeFileSync(join(root, '.gitattributes'), content);
      const out = execFileSync('git', ['-C', root, 'check-attr', '--stdin', '-z', 'linguist-generated'], { input: paths.join('\0') + '\0', encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).split('\0');
      const expected: GuideFileAttributes[] = [];
      for (let i = 0; i < out.length - 1; i += 3) if (out[i + 2] === 'set') expected.push({ path: out[i], generated: true });
      expect(explicitGuideAttributes(paths, [{ path: '.gitattributes', content }]), pattern).toEqual(expected);
      comparisons += paths.length;
    }
    expect(comparisons).toBeGreaterThan(1000);
  });
});
