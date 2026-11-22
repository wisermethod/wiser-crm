import assert from 'node:assert/strict';
export { resolvedThemes } from './theme-tokens.mjs';

const channelToLinear = (channel) => channel <= 0.04045
  ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
const linearToChannel = (linear) => linear <= 0.0031308
  ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;

export function color(color) {
  if (/^#[0-9a-f]{6}$/i.test(color)) {
    return color.slice(1).match(/../g).map((channel) => parseInt(channel, 16) / 255);
  }
  const match = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(color);
  assert.ok(match, `Unsupported contrast color ${color}`);
  const [, lightness, chroma, hue] = match;
  return quantize(oklch(Number(lightness), Number(chroma), Number(hue)).map(channel => Math.max(0, Math.min(1, channel))));
}

function oklch(lightness, chroma, hue) {
  const radians = hue * Math.PI / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ].map(linearToChannel);
}

function luminance(rgb) {
  const [r, g, b] = rgb.map(channelToLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(foreground, background) {
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function over(top, bottom, alpha) {
  return quantize(top.map((channel, i) => alpha * channel + (1 - alpha) * bottom[i]));
}

const quantize = (channels) => channels.map((channel) => Math.round(channel * 255) / 255);

// Generate in-gamut fixtures without changing the requested OKLCH hue.
export function oklchHex(lightness, chroma, hue) {
  const inGamut = channels => channels.every(channel => channel >= 0 && channel <= 1);
  let low = 0, high = chroma;
  for (let i = 0; i < 16; i++) {
    const middle = (low + high) / 2;
    if (inGamut(oklch(lightness, middle, hue))) low = middle;
    else high = middle;
  }
  return '#' + oklch(lightness, low, hue).map(channel => Math.round(channel * 255).toString(16).padStart(2, '0')).join('');
}

// The Mist audit's complete pair list. Opacity checks use 8-bit sRGB,
// matching the swatches and compositing in the Chromium capture audit.
const surfaces = ['background', 'card', 'popover', 'secondary', 'sidebar'];
export const rows = [];
function pair(label, front, back, minimum, maximum = Infinity) {
  rows.push({ label, front, back, minimum, maximum });
}
const pairs = (front, backgrounds, minimum = 4.5, label = front) => {
  for (const background of backgrounds) pair(`${label} / ${background}`, front, background, minimum);
};
for (const surface of surfaces) {
  pair(`Body text / ${surface}`, 'foreground', surface, 11, 15);
}
pair('Selected row body text / tint', 'foreground', 'accent-tint', 7);
for (const [front, back] of [
  ['card-foreground', 'card'], ['popover-foreground', 'popover'], ['sidebar-foreground', 'sidebar'],
  ['secondary-foreground', 'secondary'], ['accent-foreground', 'accent'],
  ['sidebar-accent-foreground', 'sidebar-accent'],
]) pairs(front, [back]);
for (const foreground of ['muted-foreground', 'faint', 'link', 'accent-text', 'primary-text']) {
  pairs(foreground, [...surfaces, 'accent-tint']);
}
pairs('accent-brand', ['sidebar', 'card'], 3, 'Brand mark');
pairs('primary-foreground', ['primary', 'primary-hover'], 4.5, 'Primary label');
pairs('primary-edge', surfaces, 3, 'Primary boundary');
pairs('input', [...surfaces, 'accent-tint'], 3, 'Input, checkbox, select or outlined button boundary');
pairs('accent-text', [...surfaces, 'accent-tint'], 3, 'Checked native checkbox fill');
pairs('foreground', ['secondary'], 3, 'Selected radio indicator');
pairs('ring', [...surfaces, 'accent-tint'], 3, 'Outer focus, row selection or deals state ring');
pairs('primary-focus-inner', ['primary', 'primary-hover'], 3, 'Primary inner focus ring');
pair('Dialog close icon at 70% / popover', color => over(color('foreground'), color('popover'), 0.7), 'popover', 3);
pair('Select or combobox chevron at 75% / card', color => over(color('foreground'), color('card'), 0.75), 'card', 3);
pair('Timeline icon / 10% primary tint on card', 'primary-text',
  color => over(color('primary'), color('card'), 0.1), 3);
pairs('destructive-foreground', ['destructive-hover'], 4.5, 'Destructive hover label');
for (const status of ['success', 'warning', 'info', 'destructive']) {
  pairs(status, [...surfaces, status === 'success' || status === 'warning' ? status + '-foreground' : status + '-tint']);
  pairs(status + '-solid', ['background', 'card', 'secondary'], 3, 'Semantic ' + status + ' dot or swatch');
}
pairs('foreground', ['info-tint', 'warning-foreground', 'destructive-tint']);
for (const category of [...Array.from({ length: 10 }, (_, index) => index), 'neutral']) {
  pairs(`cat-${category}-text`, [`cat-${category}-tint`]);
  pairs(`cat-${category}-solid`, ['secondary', 'popover'], 3, `Category ${category} stage dot or palette swatch`);
}
for (const color of ['rule', 'border']) {
  for (const surface of ['background', 'card']) {
    pair(`Decorative ${color} / ${surface}`, color, surface, 1, 2);
  }
}

const accentRoles = new Set([
  'accent-brand', 'accent-text', 'accent-tint', 'sidebar-accent', 'sidebar-accent-foreground',
  'primary', 'primary-foreground', 'primary-hover', 'primary-edge', 'primary-text', 'primary-focus-inner', 'ring',
]);
export const accentRows = rows.filter(({ front, back }) => accentRoles.has(front) || accentRoles.has(back));
