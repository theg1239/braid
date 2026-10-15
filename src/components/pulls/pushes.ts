/** Visible copy uses pushes; the API's revision numbers remain unchanged. */
export const pushLabel = (revision: number) => revision === 1 ? 'First push' : `Push ${revision}`;
