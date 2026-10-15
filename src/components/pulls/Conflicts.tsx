import type { Change, ChangeConflictRegion } from '../../../shared/types';
import { CONFLICT_KIND } from '../../lib/changes';
import { basename, dirname, plural, shortHash } from '../../lib/format';
import { ConflictView } from '../code';

/** One region, as Git would mark it in the file: main's lines, where both started, and this change's lines. */
function Region({ path, region, index, branch }: { path: string; region: ChangeConflictRegion; index: number; branch: string }) {
  return (
    <div className="region">
      <p className="region__lines">
        <span>
          {branch} <span className="region__line">line {region.oursStart}</span>
        </span>
        <span>
          base <span className="region__line">line {region.baseStart}</span>
        </span>
        <span>
          this change <span className="region__line">line {region.theirsStart}</span>
        </span>
      </p>
      <ConflictView path={path} region={region} branch={branch} index={index} />
    </div>
  );
}

/**
 * Exactly where this change and main disagree: where both started, what main says now, and
 * what the change says. This is what the author gets back to resolve.
 */
export function Conflicts({ change, branch }: { change: Change; branch: string }) {
  if (!change.conflicts.length) return null;
  return (
    <section className="section conflicts" aria-labelledby="conflicts-title">
      <h2 className="section__title" id="conflicts-title">
        {plural(change.conflicts.length, 'conflict')} with {branch}
        {change.conflictBase ? <span className="mono section__hash">{shortHash(change.conflictBase)}</span> : null}
      </h2>
      <div className="conflict-list">
        {change.conflicts.map((conflict) => (
          <article key={conflict.path} className="conflict">
            <header className="conflict__head">
              <span className="conflict__path mono">
                <span className="conflict__dir">{dirname(conflict.path)}</span>
                {basename(conflict.path)}
              </span>
              <span className="conflict__kind">{CONFLICT_KIND[conflict.kind]}</span>
            </header>
            {conflict.jsonPaths?.length ? (
              <p className="conflict__json">
                JSON paths in conflict: <span className="mono">{conflict.jsonPaths.join(', ')}</span>
              </p>
            ) : null}
            {conflict.regions?.map((region, index) => (
              <Region key={index} path={conflict.path} region={region} index={index} branch={branch} />
            ))}
          </article>
        ))}
      </div>
    </section>
  );
}
