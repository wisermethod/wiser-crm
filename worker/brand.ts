export interface BrandSettings {
  BRAND_NAME?: string;
  BRAND_ACCENT?: string;
}

const defaultName = "Wiser CRM";
const hexColor = /^#[0-9a-f]{6}$/i;

type RGB = [number, number, number];

const linear = (channel: number) => channel <= 0.04045
  ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
const srgb = (channel: number) => channel <= 0.0031308
  ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055;
const luminance = ([r, g, b]: RGB) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function decode(hex: string): RGB {
  return [1, 3, 5].map(offset => linear(parseInt(hex.slice(offset, offset + 2), 16) / 255)) as RGB;
}

function hueAndChroma([r, g, b]: RGB) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const blue = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const chroma = Math.hypot(a, blue);
  return { hue: Math.atan2(blue, a), chroma: chroma < 0.015 ? 0 : chroma };
}

function fromOklch(lightness: number, a: number, b: number): RGB {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

// Fit chroma along the same hue at this lightness. The neutral endpoint is
// always in gamut, so no RGB channel needs to be clipped.
function inGamut(lightness: number, a: number, b: number): RGB {
  const fits = (rgb: RGB) => rgb.every(channel => channel >= 0 && channel <= 1);
  const full = fromOklch(lightness, a, b);
  if (fits(full)) return full;
  let low = 0, high = 1;
  let result = fromOklch(lightness, 0, 0);
  for (let attempt = 0; attempt < 16; attempt++) {
    const scale = (low + high) / 2;
    const rgb = fromOklch(lightness, a * scale, b * scale);
    if (fits(rgb)) {
      low = scale;
      result = rgb;
    } else {
      high = scale;
    }
  }
  return result;
}

// Mist's original swatches supply the luminance targets. Chroma fractions
// keep tints and labels quieter than the mark, ring and action fills.
const mistRoles = {
  light: {
    "accent-brand": ["#177a6f", 0.8],
    "accent-text": ["#23665c", 0.55],
    "accent-tint": ["#e3f0ec", 0.14],
    ring: ["#277a6e", 0.68],
    primary: ["#225950", 0.5],
    "primary-hover": ["#2b665b", 0.55],
    "primary-foreground": ["#eff8f4", 0.1],
    "primary-focus-inner": ["#a3ddce", 0.42],
  },
  dark: {
    "accent-brand": ["#7bc7b9", 0.68],
    "accent-text": ["#9dd5ca", 0.49],
    "accent-tint": ["#2a433f", 0.17],
    ring: ["#82cabc", 0.64],
    primary: ["#194c44", 0.5],
    "primary-hover": ["#205b50", 0.55],
    "primary-foreground": ["#e9f5ef", 0.12],
    "primary-edge": ["#789f96", 0.35],
    // Same tone as ring: the injected light value would otherwise win on html.dark.
    "primary-focus-inner": ["#82cabc", 0.64],
  },
} as const;

type Accent = { [Mode in keyof typeof mistRoles]: Record<keyof typeof mistRoles[Mode], string> };

export function fitAccent(hex: string): Accent {
  const { hue, chroma } = hueAndChroma(decode(hex));

  function fit(roles: Record<string, readonly [string, number]>) {
    return Object.fromEntries(Object.entries(roles).map(([role, [original, fraction]]) => {
      const target = luminance(decode(original));
      const a = Math.cos(hue) * chroma * fraction;
      const b = Math.sin(hue) * chroma * fraction;
      let low = 0, high = 1;
      for (let attempt = 0; attempt < 20; attempt++) {
        const lightness = (low + high) / 2;
        if (luminance(inGamut(lightness, a, b)) < target) low = lightness;
        else high = lightness;
      }
      const rgb = inGamut((low + high) / 2, a, b);
      const color = "#" + rgb.map(channel => Math.round(srgb(channel) * 255).toString(16).padStart(2, "0")).join("");
      return [role, color];
    }));
  }

  return { light: fit(mistRoles.light), dark: fit(mistRoles.dark) } as Accent;
}

function displayName(value?: string): string {
  if (typeof value !== "string" || /[\p{Cc}\u2028\u2029<>]/u.test(value)) return defaultName;
  const name = value.trim();
  return name && [...name].length <= 40 ? name : defaultName;
}

export function installBrand(env: BrandSettings) {
  const hex = env.BRAND_ACCENT;
  return {
    name: displayName(env.BRAND_NAME),
    accent: typeof hex === "string" && hex.length === 7 && hexColor.test(hex) ? fitAccent(hex) : null,
  };
}
