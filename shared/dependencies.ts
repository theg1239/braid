import * as v from 'valibot';
/**
 * The dependency versions a change introduces, read from the manifests and
 * lockfiles it edits, in the ecosystems OSV.dev indexes. Only exact versions
 * count: a range in package.json without a lockfile resolves later, elsewhere.
 */
export interface Dependency { ecosystem: 'npm' | 'PyPI' | 'Go' | 'crates.io'; name: string; version: string; path: string }

const key = (dependency: Omit<Dependency, 'path'>) => `${dependency.ecosystem}:${dependency.name}@${dependency.version}`;
const EXACT = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const versions = v.optional(v.record(v.string(), v.string()), {});
const npmManifest = v.pipe(v.string(), v.parseJson(), v.object({ dependencies: versions, devDependencies: versions, optionalDependencies: versions }));
const npmLock = v.pipe(v.string(), v.parseJson(), v.object({ packages: v.optional(v.record(v.string(), v.object({ version: v.optional(v.string()), link: v.optional(v.boolean()) })), {}) }));

function parse(path: string, text: string | null): Dependency[] {
  if (!text) return [];
  const name = path.split('/').pop()!;
  if (name === 'package-lock.json' || name === 'npm-shrinkwrap.json') {
    const lock = v.safeParse(npmLock, text);
    return lock.success ? Object.entries(lock.output.packages).flatMap(([location, entry]) => {
      const at = location.lastIndexOf('node_modules/');
      if (at < 0 || entry.link || !entry.version || !EXACT.test(entry.version)) return [];
      return [{ ecosystem: 'npm' as const, name: location.slice(at + 'node_modules/'.length), version: entry.version, path }];
    }) : [];
  }
  if (name === 'package.json') {
    const manifest = v.safeParse(npmManifest, text);
    return manifest.success ? Object.values(manifest.output).flatMap(section => Object.entries(section)
      .filter(([, version]) => EXACT.test(version.replace(/^=/, '')))
      .map(([dependency, version]) => ({ ecosystem: 'npm' as const, name: dependency, version: version.replace(/^=/, ''), path }))) : [];
  }
  if (/^requirements[\w.-]*\.txt$/.test(name)) {
    return text.split('\n').flatMap(line => {
      const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*==\s*([0-9][0-9A-Za-z.+!-]*)\s*(?:#.*|;.*)?$/.exec(line);
      return match ? [{ ecosystem: 'PyPI' as const, name: match[1], version: match[2], path }] : [];
    });
  }
  if (name === 'go.mod') {
    return text.split('\n').flatMap(line => {
      const match = /^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]{2,}\/[^\s]+)\s+v(\d+\.\d+\.\d+[^\s]*)/.exec(line);
      return match ? [{ ecosystem: 'Go' as const, name: match[1], version: match[2], path }] : [];
    });
  }
  if (name === 'Cargo.lock') {
    return [...text.matchAll(/\[\[package\]\]\s*\nname = "([^"]+)"\s*\nversion = "([^"]+)"/g)].map(match => ({ ecosystem: 'crates.io' as const, name: match[1], version: match[2], path }));
  }
  return [];
}

/** Dependency versions present after the change that were not present before it. */
export function introducedDependencies(files: { path: string; before: string | null; after: string | null }[]): Dependency[] {
  const introduced = new Map<string, Dependency>();
  for (const file of files) {
    const before = new Set(parse(file.path, file.before).map(key));
    for (const dependency of parse(file.path, file.after)) if (!before.has(key(dependency))) introduced.set(key(dependency), dependency);
  }
  return [...introduced.values()].slice(0, 500);
}
