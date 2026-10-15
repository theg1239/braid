import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const project = join(import.meta.dirname, '..', '..');

describe('the npm tarball', () => {
  const root = mkdtempSync('/tmp/braid-npm-test-');
  const source = join(root, 'source'), consumer = join(root, 'consumer');
  const packed = join(consumer, 'package');
  const env = { ...process.env, BRAID_CONFIG_HOME: join(root, 'config') };
  const run = (command: string, args: string[], cwd: string) => execFileSync(command, args, { cwd, env, encoding: 'utf8', stdio: 'pipe', timeout: 60_000 });

  beforeAll(() => {
    // Pack a source-only copy, so a stale bundle in this shared checkout cannot make this pass.
    mkdirSync(join(source, 'cli'), { recursive: true });
    for (const path of ['package.json', 'README.md', 'rolldown.config.ts', 'src', 'scripts']) {
      cpSync(join(project, 'cli', path), join(source, 'cli', path), { recursive: true });
    }
    cpSync(join(project, 'shared'), join(source, 'shared'), { recursive: true });
    cpSync(join(project, 'LICENSE'), join(source, 'LICENSE'));
    symlinkSync(join(project, 'node_modules'), join(source, 'node_modules'), 'dir');
    mkdirSync(join(source, 'cli', 'dist'));
    writeFileSync(join(source, 'cli', 'dist', 'stale.map'), 'excluded development output');
    writeFileSync(join(source, 'cli', '.dev.vars'), 'excluded fixture, no credentials');
    run('npm', ['pack', '--pack-destination', root], join(source, 'cli'));
    const archive = readdirSync(root).find(path => path.endsWith('.tgz'))!;
    mkdirSync(consumer);
    run('tar', ['-xzf', join(root, archive), '-C', consumer], root);
  }, 120_000);

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('ships only the executable, license notices, readme and metadata without runtime dependencies', () => {
    const files = readdirSync(packed, { recursive: true }).filter(path => statSync(join(packed, String(path))).isFile()).sort();
    expect(files).toEqual(['README.md', 'dist/LICENSE', 'dist/braid.mjs', 'package.json']);
    const metadata = JSON.parse(readFileSync(join(packed, 'package.json'), 'utf8'));
    expect(metadata).toMatchObject({ name: 'braid-git', license: 'MIT', homepage: 'https://braid-git.acmvit.workers.dev', bin: { braid: 'dist/braid.mjs', 'braid-git': 'dist/braid.mjs' } });
    expect(metadata.dependencies ?? {}).toEqual({});
    expect(metadata.optionalDependencies ?? {}).toEqual({});
    for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) expect(metadata.scripts).not.toHaveProperty(hook);
    const licenses = readFileSync(join(packed, 'dist', 'LICENSE'), 'utf8');
    for (const owner of ['Braid contributors', 'Bloomberg Finance L.P.', 'Fabian Hiller']) expect(licenses).toContain(owner);
  });

  it('ships both executable names without an install or the registry', () => {
    const metadata = JSON.parse(readFileSync(join(packed, 'package.json'), 'utf8'));
    for (const name of ['braid', 'braid-git']) {
      const help = run(process.execPath, [join(packed, metadata.bin[name]), '--help'], consumer);
      for (const command of ['init', 'submit', 'blame', 'stats']) expect(help).toContain(command);
    }
  });

  it('runs the bundled executable away from node_modules with its shebang and permissions intact', () => {
    const executable = join(root, 'standalone.mjs');
    cpSync(join(packed, 'dist', 'braid.mjs'), executable);
    expect(readFileSync(executable, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(statSync(executable).mode & 0o111).toBe(0o111);
    const { version } = JSON.parse(readFileSync(join(packed, 'package.json'), 'utf8'));
    expect(run(executable, ['--version'], root)).toBe(`${version}\n`);
  });

  it('builds the same executable from the checkout root and the package directory', () => {
    run(join(project, 'node_modules', '.bin', 'rolldown'), ['-c', 'cli/rolldown.config.ts'], source);
    expect(readFileSync(join(source, 'cli', 'dist', 'braid.mjs'))).toEqual(readFileSync(join(packed, 'dist', 'braid.mjs')));
  });
});
