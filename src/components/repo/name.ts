/** A repository name the server accepts, from any text: lowercase, hyphens for the rest, starting with a letter. */
export function repositoryName(text: string): string {
  const value = text.toLowerCase().replace(/[^a-z\d-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  if (!value) return 'repository';
  const named = (/^[a-z]/.test(value) ? value : `repo-${value}`).slice(0, 48).replace(/-+$/, '');
  return named.length < 2 ? `${named}-repo` : named;
}
