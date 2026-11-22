import assert from 'node:assert/strict';
import test from 'node:test';
import { color, contrast, resolvedThemes, rows } from './theme-contrast-pairs.mjs';

test('all Mist pairings meet their contrast targets in both modes', () => {
  const themes = resolvedThemes();
  const report = process.env.WISER_THEME_CONTRAST_REPORT === '1';
  assert.equal(rows.length, 152);
  if (report) {
    console.log('| Foreground or cue / adjacent surface | Target | Light | Dark |');
    console.log('| --- | ---: | ---: | ---: |');
  }
  for (const { label, front, back, minimum, maximum } of rows) {
    const ratios = ['light', 'dark'].map((mode, index) => {
      const get = token => color(themes[index][token]);
      const resolve = role => typeof role === 'function' ? role(get) : get(role);
      const ratio = contrast(resolve(front), resolve(back));
      assert.ok(ratio >= minimum && ratio <= maximum, `${label}, ${mode}: ${ratio.toFixed(4)}:1`);
      return ratio.toFixed(3);
    });
    if (report) {
      const target = Number.isFinite(maximum) ? `${minimum} to ${maximum}` : minimum;
      console.log(`| ${label} | ${target} | ${ratios.join(' | ')} |`);
    }
  }
});
