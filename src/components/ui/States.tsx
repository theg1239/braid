import type { ReactNode } from 'react';
import { Banner, Button, Text } from '@cloudflare/kumo';
import { emptyVariants } from '@cloudflare/kumo/components/empty';
import { ArrowClockwiseIcon, WarningCircleIcon } from '@phosphor-icons/react';

export function PageState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="state state--page">
      <h1>{title}</h1>
      {children}
    </div>
  );
}

export function ErrorPanel({ title, message, onRetry, retrying = false, retryLabel = 'Try again', page = false, heading }: { title: string; message?: string; onRetry?: () => void; retrying?: boolean; retryLabel?: string; page?: boolean; heading?: Heading }) {
  const action = onRetry ? (
    <Button variant="secondary" size="sm" icon={ArrowClockwiseIcon} disabled={retrying} onClick={onRetry}>
      {retryLabel}
    </Button>
  ) : undefined;
  if (page) return <div role="alert"><PageState title={title}>{message ? <p>{message}</p> : null}{action}</PageState></div>;
  return (
    <div className="state" role="alert">
      <StateContents
        icon={<WarningCircleIcon size={28} className="state__icon" />}
        title={title}
        description={message}
        action={action}
        heading={heading}
      />
    </div>
  );
}

/** A panel inside a page titles itself as a section; a panel that is the whole page, such as a 404, takes the page's h1. */
type Heading = 'h1' | 'h2';

/** A failed refresh keeps the last answer in place and offers a retry beside it. */
export function ErrorNotice({ message, onRetry, retrying }: { message: string; onRetry: () => void; retrying?: boolean }) {
  return <div role="alert"><Banner variant="secondary" size="sm" description={message} action={<Button size="sm" variant="secondary" disabled={retrying} onClick={onRetry}>Try again</Button>} /></div>;
}

export function EmptyPanel({ icon, title, description, action, size = 'sm', heading }: { icon?: ReactNode; title: string; description?: string; action?: ReactNode; size?: 'sm' | 'base'; heading?: Heading }) {
  return (
    <div className="state">
      <StateContents size={size} icon={icon} title={title} description={description} action={action} heading={heading} />
    </div>
  );
}

/** Kumo's Empty, with the heading level chosen by the caller. */
function StateContents({ icon, title, description, action, size = 'sm', heading = 'h2' }: Parameters<typeof EmptyPanel>[0]) {
  return <div className={emptyVariants({ size })}>
    {icon}
    <div className="flex flex-col items-center gap-2.5">
      {description ? <Text as={heading} variant="heading" size="lg">{title}</Text> : <Text as={heading} variant="secondary" size="base">{title}</Text>}
      {description ? <Text variant="secondary" size="base" DANGEROUS_className="max-w-140 text-center text-balance leading-normal">{description}</Text> : null}
    </div>
    {action}
  </div>;
}
