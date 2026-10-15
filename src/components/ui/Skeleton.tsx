import type { CSSProperties, ReactNode } from 'react';
import './skeleton.css';

/** Deterministic widths keep server, first render and subsequent renders identical. */
export function SkeletonLine({ width = '100%', height = 12, className = '' }: { width?: CSSProperties['width']; height?: number; className?: string }) {
  return <span aria-hidden="true" className={`skeleton-line ${className}`} style={{ width, height }} />;
}

export function SkeletonRow({ index = 0, detail = false, icon = true, height = detail ? 58 : 38 }: { index?: number; detail?: boolean; icon?: boolean; height?: number }) {
  return <div className="skeleton-row" style={{ minHeight: height }} aria-hidden="true">
    {icon ? <SkeletonLine width={16} height={14} /> : null}
    <div className="skeleton-row__text">
      <SkeletonLine width={`${[42, 61, 33, 52, 26, 47][index % 6]}%`} />
      {detail ? <SkeletonLine width={`${[28, 38, 22][index % 3]}%`} height={10} /> : null}
    </div>
  </div>;
}

export function SkeletonBox({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`skeleton-box ${className}`}>{children}</div>;
}

/** Preserve the region while it reads; the request deadline supplies an error and retry if it stalls. */
export function LoadingRegion({ children, label = 'Loading', className = '' }: { children: ReactNode; label?: string; className?: string }) {
  return <div className={`loading-region ${className}`} role="status" aria-label={label} aria-busy="true">
    {children}
  </div>;
}

export function SkeletonRows({ rows = 6, label = 'Loading', detail = false, height, className = '' }: { rows?: number; label?: string; detail?: boolean; height?: number; className?: string }) {
  return <LoadingRegion label={label} className={className}>
    {Array.from({ length: rows }, (_, index) => <SkeletonRow key={index} index={index} detail={detail} height={height} />)}
  </LoadingRegion>;
}

export function SkeletonParagraph({ label = 'Loading README' }: { label?: string }) {
  return <LoadingRegion label={label} className="skeleton-paragraph">
    <SkeletonLine width="42%" height={24} />
    {[92, 86, 94, 68].map(width => <SkeletonLine key={width} width={`${width}%`} />)}
  </LoadingRegion>;
}
