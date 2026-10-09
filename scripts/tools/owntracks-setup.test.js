import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup } from './owntracks-setup.mjs';

test('설정을 600 권한으로 한 번만 만들고 비밀번호를 반환하지 않는다', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'd89-setup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'owntracks.json');
  assert.throws(() => setup({ host: '0.0.0.0', path }), /Tailscale/);
  const result = setup({ host: '100.64.0.1', path });
  assert.deepEqual(Object.keys(result), ['host', 'port', 'username']);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.ok(JSON.parse(readFileSync(path, 'utf8')).password.length >= 32);
  assert.throws(() => setup({ host: '100.64.0.1', path }), /이미/);
});
