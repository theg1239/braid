import { createContext, useContext } from 'react';
import { paths } from '../../lib/router';

/**
 * The branch this page reads: the default unless the address names another, as `tree/<branch>` does on GitHub.
 * While an import copies, `streaming` reads the branch being copied straight from its source.
 */
export const Branch = createContext({ name: 'main', gitRef: '', main: true, streaming: false });
export const useBranch = () => useContext(Branch);
/** Code links that stay on the branch being read. */
export function useCodeHref() {
  const { name, main } = useBranch();
  return (path?: string | null, options?: { view?: 'blame'; kind?: 'dir' | 'file' }) => paths.code(path, main ? options : { ...options, ref: name });
}
