import { dark, light, type Palette } from '../colors';

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const pairs: [keyof Palette, keyof Palette][] = [
  ['text', 'background'],
  ['text', 'card'],
  ['secondaryText', 'card'],
  ['secondaryText', 'background'],
  ['secondaryText', 'fill'],
  ['accent', 'card'],
  ['accent', 'background'],
  ['onAccent', 'accent'],
  ['toastText', 'toastBackground'],
  ['toastAction', 'toastBackground'],
];

describe.each([
  ['light', light],
  ['dark', dark],
])('%s palette', (_name, palette) => {
  it.each(pairs)('%s on %s meets 4.5:1', (fg, bg) => {
    expect(contrast(palette[fg], palette[bg])).toBeGreaterThanOrEqual(4.5);
  });

  it('white action labels meet 4.5:1 on Tomorrow and Drop', () => {
    expect(contrast('#FFFFFF', palette.deferAction)).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#FFFFFF', palette.dropAction)).toBeGreaterThanOrEqual(4.5);
  });
});
