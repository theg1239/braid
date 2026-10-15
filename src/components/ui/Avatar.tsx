import { useState, type ReactNode } from 'react';

/** A linked profile image, with the same neutral fallback after an image fails. */
export function Avatar({ src, size, fallback, className }: { src?: string | null; size: number; fallback: ReactNode; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  return src && src !== failed ? <img className={className} src={src} width={size} height={size} alt="" onError={() => setFailed(src)} /> : fallback;
}
