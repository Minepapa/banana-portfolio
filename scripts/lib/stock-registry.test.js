import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFrontmatter } from './vault-frontmatter.mjs';
import { buildCodeRegistry, resolveCanonicalStockName } from './stock-registry.mjs';

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), 'stock-registry-test-'));
}

test('buildCodeRegistry: State/Holdings의 ticker→name을 등록', () => {
  const holdingsDir = makeTmpDir();
  try {
    writeFileSync(join(holdingsDir, '위탁-삼성전자.md'), buildFrontmatter({ type: 'holding', ticker: '005930', name: '삼성전자' }));
    const registry = buildCodeRegistry({ holdingsDir, executionsDir: '/no/such/dir' });
    assert.equal(registry.get('005930'), '삼성전자');
  } finally {
    rmSync(holdingsDir, { recursive: true, force: true });
  }
});

test('buildCodeRegistry: ticker가 빈 문자열이면 등록 안 함(예: 백필 안 된 보유)', () => {
  const holdingsDir = makeTmpDir();
  try {
    writeFileSync(join(holdingsDir, '위탁-SK하이닉스.md'), buildFrontmatter({ type: 'holding', ticker: '', name: 'SK하이닉스' }));
    const registry = buildCodeRegistry({ holdingsDir, executionsDir: '/no/such/dir' });
    assert.equal(registry.size, 0);
  } finally {
    rmSync(holdingsDir, { recursive: true, force: true });
  }
});

test('[퀀트 코드↔이름 재현] buildCodeRegistry: Executions의 stockCode+stockName으로 Holdings에 없는 code도 보강', () => {
  const executionsDir = makeTmpDir();
  try {
    // 퀀트 트랙은 State/Holdings를 안 쓰지만(계좌분리 원칙), 체결 시점엔 stockCode·
    // stockName이 함께 기록된다(watch-order-fill.mjs) — 실제 vault 실측(017670↔
    // SK텔레콤)과 동일한 형태로 재현.
    writeFileSync(
      join(executionsDir, '2026-08-12-매수-SK텔레콤.md'),
      buildFrontmatter({ type: 'execution', stockCode: '017670', stockName: 'SK텔레콤' }),
    );
    const registry = buildCodeRegistry({ holdingsDir: '/no/such/dir', executionsDir });
    assert.equal(registry.get('017670'), 'SK텔레콤');
  } finally {
    rmSync(executionsDir, { recursive: true, force: true });
  }
});

test('buildCodeRegistry: 같은 code가 Holdings·Executions 둘 다에 있으면 Holdings가 우선', () => {
  const holdingsDir = makeTmpDir();
  const executionsDir = makeTmpDir();
  try {
    writeFileSync(join(holdingsDir, '위탁-삼성전자.md'), buildFrontmatter({ type: 'holding', ticker: '005930', name: '삼성전자' }));
    writeFileSync(join(executionsDir, 'x.md'), buildFrontmatter({ type: 'execution', stockCode: '005930', stockName: '삼성전자보통주(다른표기)' }));
    const registry = buildCodeRegistry({ holdingsDir, executionsDir });
    assert.equal(registry.get('005930'), '삼성전자');
  } finally {
    rmSync(holdingsDir, { recursive: true, force: true });
    rmSync(executionsDir, { recursive: true, force: true });
  }
});

test('buildCodeRegistry: 디렉터리가 없으면 안 죽고 빈 registry', () => {
  const registry = buildCodeRegistry({ holdingsDir: '/no/such/dir', executionsDir: '/no/such/dir2' });
  assert.equal(registry.size, 0);
});

test('resolveCanonicalStockName: 수동 별칭표가 code 레지스트리보다 먼저 적용됨', () => {
  const registry = new Map([['A', 'code로 찾은 이름']]);
  // "하이닉스"는 stock-aliases.mjs에 등록된 실제 별칭 — 별칭표가 registry 조회보다
  // 먼저 확인되므로 registry에 뭐가 있든 별칭표 결과가 나와야 한다.
  assert.equal(resolveCanonicalStockName('하이닉스', registry), 'SK하이닉스');
});

test('resolveCanonicalStockName: code로 등록된 값이면 표준명으로 치환', () => {
  const registry = new Map([['017670', 'SK텔레콤']]);
  assert.equal(resolveCanonicalStockName('017670', registry), 'SK텔레콤');
});

test('resolveCanonicalStockName: 둘 다 매칭 안 되면 원본 그대로(안전한 폴백)', () => {
  assert.equal(resolveCanonicalStockName('테슬라', new Map()), '테슬라');
});

test('resolveCanonicalStockName: 빈 값이면 그대로 반환(죽지 않음)', () => {
  assert.equal(resolveCanonicalStockName('', new Map()), '');
  assert.equal(resolveCanonicalStockName(null, new Map()), null);
});
