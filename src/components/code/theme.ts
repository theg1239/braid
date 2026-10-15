import vesper from '@shikijs/themes/vesper';

// Vesper's translucent comments and Markdown punctuation disappear on diff tints.
// Keep its palette, with opaque foregrounds that pass AA on Braid's code surfaces.
const foregrounds: Record<string, string> = {
  '#8b8b8b94': '#aaaaaa',
  '#00000050': '#aaaaaa',
  '#65737e': '#aaaaaa',
  '#a0a0a0': '#aaaaaa',
  '#ffff': '#ffffff',
};

export default {
  ...vesper,
  name: 'braid-dark',
  tokenColors: vesper.tokenColors!.map(token => {
    const foreground = token.settings?.foreground;
    return foreground ? { ...token, settings: { ...token.settings, foreground: foregrounds[foreground.toLowerCase()] ?? foreground } } : token;
  }),
};
