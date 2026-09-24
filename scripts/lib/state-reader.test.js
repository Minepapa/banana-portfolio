import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const stateReader = await import('./state-reader.mjs').catch(() => ({}));

test('readOptionalStateFile: ENOENT만 기본값으로 취급하고 그 외 읽기 오류는 전파', () => {
  assert.equal(typeof stateReader.readOptionalStateFile, 'function');
  const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
  const denied = Object.assign(new Error('denied'), { code: 'EACCES' });

  assert.equal(stateReader.readOptionalStateFile('/unused', () => { throw missing; }), null);
  assert.throws(() => stateReader.readOptionalStateFile('/unused', () => { throw denied; }), denied);
  assert.equal(stateReader.readOptionalStateFile('/unused', () => 'active: true'), 'active: true');
});

test('실제 주문 진입점은 킬스위치·체결모드를 공용 fail-closed 읽기로 확인', () => {
  const root = new URL('../../', import.meta.url);
  for (const file of [
    'scripts/tools/execute-asset-allocation-proposal.mjs',
    'scripts/tools/execute-quant-proposal.mjs',
    'scripts/tools/modify-cancel-nh-order.mjs',
  ]) {
    const source = readFileSync(new URL(file, root), 'utf8');
    assert.match(source, /readOptionalStateFile\(VAULT_PATHS\.state\.killSwitch\)/, file);
    assert.match(source, /readOptionalStateFile\(VAULT_PATHS\.state\.executionMode\)/, file);
  }
});
