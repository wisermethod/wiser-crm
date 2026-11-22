import assert from "node:assert/strict";
import test from "node:test";
import { fitAccent, installBrand } from "./brand.ts";
import { accentRows, color, contrast, oklchHex, resolvedThemes } from "../tests/theme-contrast-pairs.mjs";

test("every brand accent pairing passes in both modes over 24 hues and a range of tones", () => {
  const hues = Array.from({ length: 24 }, (_, i) => i * 15);
  const inputs = [...hues.flatMap(hue => [0.25, 0.55, 0.85].flatMap(lightness =>
    [0.03, 0.12, 0.3].map(chroma => oklchHex(lightness, chroma, hue)))),
  "#000000", "#ffffff", "#808080", "#838282", "#ffff00", "#0000ff", "#7a4bd6"];
  const commonRoles = ["accent-brand", "accent-text", "accent-tint", "primary", "primary-foreground", "primary-hover", "ring"];
  // Dark sets its own focus edge: the injected light value would otherwise win on html.dark.
  const extraRoles = { light: ["primary-focus-inner"], dark: ["primary-edge", "primary-focus-inner"] };
  const minimums = new Map();
  assert.equal(accentRows.length, 42);
  const themes = resolvedThemes();
  for (const input of inputs) {
    const accent = fitAccent(input);
    for (const [index, mode] of ["light", "dark"].entries()) {
      assert.deepEqual(Object.keys(accent[mode]).sort(), [...commonRoles, ...extraRoles[mode]].sort());
      const theme = { ...themes[index], ...accent[mode] };
      theme["sidebar-accent"] = theme["accent-tint"];
      theme["sidebar-accent-foreground"] = theme["accent-text"];
      if (mode === "light") {
        theme["primary-edge"] = theme.primary;
        theme["primary-text"] = theme.primary;
      } else {
        theme["primary-text"] = theme["accent-text"];
        assert.equal(accent.dark["primary-focus-inner"], accent.dark.ring);
      }
      const get = name => color(theme[name]);
      for (const { label, front, back, minimum, maximum } of accentRows) {
        const resolve = value => typeof value === "function" ? value(get) : get(value);
        const ratio = contrast(resolve(front), resolve(back));
        assert.ok(ratio >= minimum && ratio <= maximum, `${input}, ${mode}, ${label}: ${ratio}`);
        const key = `${mode}, minimum ${minimum}:1`;
        if (ratio < (minimums.get(key)?.ratio ?? Infinity)) minimums.set(key, { ratio, label, input });
      }
    }
  }
  assert.equal(inputs.length, 223);
  for (const tokens of Object.values(fitAccent("#7a4bd6"))) {
    for (const value of Object.values(tokens)) {
      const [red, green, blue] = color(value);
      assert.ok(blue > red && red > green, `${value} retains the custom violet hue`);
    }
  }
  for (const hex of ["#000000", "#ffffff", "#808080", "#838282"]) {
    for (const tokens of Object.values(fitAccent(hex))) {
      for (const value of Object.values(tokens)) assert.match(value, /^#([0-9a-f]{2})\1\1$/);
    }
  }
  if (process.env.WISER_THEME_CONTRAST_REPORT === "1") {
    for (const [key, { ratio, label, input }] of minimums) {
      console.log(`${key}: ${ratio.toFixed(4)}:1 (${label}, ${input})`);
    }
  }
});

test("install brand validates each setting independently, trims names, and accepts Unicode text", () => {
  const fallback = { name: "Wiser CRM", accent: null };
  assert.deepEqual(installBrand({}), fallback);
  for (const name of ["<em>fake</em>", "x>y", "X\n", "X\r", "X\u0085", "X\u2028", "X\u2029", "\tX", " ", "X".repeat(41)]) {
    assert.deepEqual(installBrand({ BRAND_NAME: name }), fallback);
  }
  for (const hex of ["#123", "#123456\n", " #123456", "#g12345", "123456"]) {
    assert.deepEqual(installBrand({ BRAND_ACCENT: hex }), fallback);
  }
  assert.deepEqual(installBrand({ BRAND_NAME: "  Maison & Étoile  ", BRAND_ACCENT: "bad" }),
    { ...fallback, name: "Maison & Étoile" });
  assert.equal(installBrand({ BRAND_NAME: "🌙".repeat(40) }).name, "🌙".repeat(40));
  assert.deepEqual(installBrand({ BRAND_NAME: "<em>fake</em>", BRAND_ACCENT: "#7A4BD6" }),
    { name: fallback.name, accent: fitAccent("#7a4bd6") });
});
