import { useEffect } from 'react';

/** Names the browser tab while the calling screen shows; null, while the title is unknown, leaves it as it is. */
export function useDocumentTitle(title: string | null) {
  useEffect(() => {
    if (title) document.title = title;
  }, [title]);
}
