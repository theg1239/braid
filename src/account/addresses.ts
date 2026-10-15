import { useEffect, useState, useSyncExternalStore } from 'react';
import { isMirrorFailure, type MirrorAddress as RepositoryAddress } from './mirrors';
import { ApiError, errorMessage, request } from '../lib/api';
import type { Address } from '../lib/router';

/*
 * What `GET /api/repos/:owner/:repo` answered for each address this page asked about. A public
 * repository answers the same signed in or out; a private one a person may read is found in their
 * account first, so the answer never depends on who asked. Signing in or out forgets everything.
 */

type Answer = RepositoryAddress | 'missing';

const answers = new Map<string, Answer>();
const loads = new Map<string, Promise<Answer>>();
const listeners = new Set<() => void>();
let version = 0, generation = 0;

const key = (address: Address) => `${address.owner}/${address.repo}`;

function touch() {
  version++;
  for (const listener of listeners) listener();
}

export function resetAddresses() {
  generation++;
  answers.clear();
  loads.clear();
  touch();
}

/** A claim changes access for the same viewer; keep readable pages mounted until the new answer arrives. */
export async function refreshOwnerAddresses(slug: string) {
  const startedIn = generation;
  // An address that was missing may be found now; forgetting it asks again.
  for (const [id, answer] of answers) if (answer === 'missing' && id.slice(0, id.indexOf('/')) === slug) answers.delete(id);
  touch();
  await Promise.all([...answers].filter(([, answer]) => answer !== 'missing' && answer.owner.slug === slug).map(async ([id]) => {
    const found = await request<RepositoryAddress>(`/api/repos/${id.split('/').map(encodeURIComponent).join('/')}`, { cache: 'reload' });
    if (startedIn !== generation) return;
    answers.set(id, found);
    touch();
  }));
}

/** One request per address; concurrent callers share it. A 404 is an answer, not a failure. */
function loadAddress(address: Address): Promise<Answer> {
  const id = key(address);
  const known = answers.get(id);
  if (known) return Promise.resolve(known);
  let promise = loads.get(id);
  if (!promise) {
    const startedIn = generation;
    // Anyone who may read a repository finds it by its address; a private or unknown one is a 404.
    promise = request<RepositoryAddress>(`/api/repos/${encodeURIComponent(address.owner)}/${encodeURIComponent(address.repo)}`)
      .then((found): Answer => found)
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 404 && !isMirrorFailure(error.code)) return 'missing' as const;
        throw error;
      })
      .then((answer) => {
        // A session reset can happen while headers or the response body are still arriving.
        if (startedIn !== generation) return 'missing' as const;
        answers.set(id, answer);
        touch();
        return answer;
      })
      .finally(() => {
        if (loads.get(id) === promise) loads.delete(id);
      });
    loads.set(id, promise);
  }
  return promise;
}

/** Starts resolving an address before the account answers, so a repository page waits for neither: the repository, or null when there is none for this viewer. */
export function primeAddress(address: Address): Promise<RepositoryAddress | null> {
  return loadAddress(address).then((answer) => (answer === 'missing' ? null : answer), () => null);
}

type AddressResult = { status: 'loading' } | { status: 'ready'; address: RepositoryAddress } | { status: 'missing' } | { status: 'error'; message: string; code?: string };

/** The repository at an address: found, missing (private or unknown), failed with retry, or still being asked. */
export function useRepositoryAddress(address: Address): AddressResult & { retry: () => void } {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
    () => version,
  );
  const id = key(address);
  const [failure, setFailure] = useState<{ id: string; message: string; code?: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const epoch = generation, known = answers.has(id);
  useEffect(() => {
    if (known) return;
    let cancelled = false;
    loadAddress(address).catch((error: unknown) => {
      if (!cancelled) setFailure({ id, message: errorMessage(error), code: error instanceof ApiError ? error.code : undefined });
    });
    return () => {
      cancelled = true;
    };
    // The address is its key; a forgotten answer is asked again.
  }, [id, attempt, epoch, known]);
  const retry = () => {
    setFailure(null);
    setAttempt((n) => n + 1);
  };
  const answer = answers.get(id);
  if (answer === 'missing') return { status: 'missing', retry };
  if (answer) return { status: 'ready', address: answer, retry };
  if (failure?.id === id) return { status: 'error', message: failure.message, code: failure.code, retry };
  return { status: 'loading', retry };
}
