import { useEffect, useRef, type ReactNode } from 'react';

/** A submitted choice or merge replaces this step without pulling the agent details up. */
export function TaskStep({ children }: { children: ReactNode }) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = container.current!;
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (width === element.clientWidth) return;
      width = element.clientWidth;
      element.style.minHeight = '';
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return <div ref={container} onClickCapture={event => {
    if ((event.target as Element).closest('button[data-task-write]')) {
      event.currentTarget.style.minHeight = `${event.currentTarget.getBoundingClientRect().height}px`;
    }
  }}>{children}</div>;
}
