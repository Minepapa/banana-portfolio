import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PAPER, PAPER_2, CARD_BG, INK, INK_2, ACCENT, ALERT, BORDER_COLOR,
} from './theme.js';
import { PROFIT_POS, PROFIT_NEG } from './colors.js';

test('theme structure tokens defer their values to CSS custom properties', () => {
  assert.deepEqual(
    { PAPER, PAPER_2, CARD_BG, INK, INK_2, ACCENT, ALERT, BORDER_COLOR },
    {
      PAPER: 'var(--paper)', PAPER_2: 'var(--paper-2)', CARD_BG: 'var(--card)',
      INK: 'var(--ink)', INK_2: 'var(--ink-2)', ACCENT: 'var(--accent)',
      ALERT: 'var(--alert)', BORDER_COLOR: 'var(--border-color)',
    },
  );
});

test('profit colors defer their values to CSS custom properties', () => {
  assert.equal(PROFIT_POS, 'var(--profit-pos)');
  assert.equal(PROFIT_NEG, 'var(--profit-neg)');
});
