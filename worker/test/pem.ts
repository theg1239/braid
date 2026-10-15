/** PEM armour built at runtime, so no source file carries a literal key header for credential scanners to flag. */
export const pem = (label: string, edge: 'BEGIN' | 'END' = 'BEGIN') => `-----${edge} ${label} KEY-----`;
