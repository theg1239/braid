import { forwardRef, type AnchorHTMLAttributes, type MouseEvent } from 'react';
import { prefetchHref } from '../../lib/prefetch';
import { isAppPath, isPlainLeftClick, navigate } from '../../lib/router';

interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  /** Kumo's deprecated alias for href. */
  to?: string;
  replace?: boolean;
}

/**
 * Anchor with in-app navigation. Given to Kumo's LinkProvider, so Kumo Link, LinkButton and
 * Breadcrumbs route without a full page load. A pointer, focus or touch on the link starts
 * loading its screen and data, so the click itself has little left to wait for.
 */
export const RouterLink = forwardRef<HTMLAnchorElement, LinkProps>(function RouterLink({ href, to, replace, onClick, target, ...rest }, ref) {
  const destination = href ?? to;
  const warm = () => prefetchHref(destination);
  return (
    <a
      ref={ref}
      href={destination}
      target={target}
      onPointerEnter={warm}
      onFocus={warm}
      onTouchStart={warm}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(event);
        if (!isAppPath(destination) || (target && target !== '_self') || !isPlainLeftClick(event)) return;
        event.preventDefault();
        navigate(destination, { replace });
      }}
      {...rest}
    />
  );
});
