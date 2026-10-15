import { describe, expect, it } from 'vitest';
import theme from './theme';

function luminance(hex: string) {
  const digits = hex.slice(1);
  const rgb = digits.length === 3 ? [...digits].map(c => c + c).join('') : digits;
  const linear = [0, 2, 4].map(i => parseInt(rgb.slice(i, i + 2), 16) / 255).map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

const foregrounds = [...new Set(theme.tokenColors.flatMap(token => token.settings?.foreground ? [token.settings.foreground] : []))];
describe.each(foregrounds)('syntax foreground %s', foreground => {
  it('is opaque', () => expect(foreground).toMatch(/^#(?:[a-f\d]{3}|[a-f\d]{6})$/i));
  // The selected gutter is brighter than the selected code line: test the stricter surface too.
  it.each(['#0f0f0f', '#111211', '#283967'])('meets normal-text AA against %s', background => {
    expect((luminance(foreground) + 0.05) / (luminance(background) + 0.05)).toBeGreaterThanOrEqual(4.5);
  });
});
