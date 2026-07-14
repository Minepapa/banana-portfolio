// 에이전트 정의 로더 테스트 — 판테온 조직 개편(2026-07-15)의 계약 검증.
// 핵심 계약: (1) parseAgentMd 는 flat frontmatter 만 허용, 어긋나면 throw.
// (2) loadAgent 는 절대 throw 하지 않는다 — 손상/누락 시 폴백 모델 + warning 반환
//     (무인 잡이 에이전트 파일 문제로 죽거나, 조용히 잘못된 모델로 도는 것 둘 다 방지).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAgentMd, loadAgent } from './agent-loader.mjs';

const VALID = `---
name: athena
description: 투자전략실 — 평가·주문서 초안
model: sonnet
---

# Athena — 투자전략실

책임: 5축 평가. 경계: 제안까지만.
`;

test('parseAgentMd: 정상 파일 — 필드·본문 추출', () => {
  const r = parseAgentMd(VALID);
  assert.equal(r.name, 'athena');
  assert.equal(r.model, 'sonnet');
  assert.ok(r.systemPrompt.startsWith('# Athena'));
  assert.ok(r.systemPrompt.includes('경계: 제안까지만.'));
});

test('parseAgentMd: CRLF 줄바꿈 허용', () => {
  const r = parseAgentMd(VALID.replace(/\n/g, '\r\n'));
  assert.equal(r.model, 'sonnet');
  assert.ok(r.systemPrompt.includes('Athena'));
});

test('parseAgentMd: 값의 따옴표 제거, 본문 안 콜론·--- 은 안전', () => {
  const r = parseAgentMd(`---\nname: "themis"\nmodel: 'sonnet'\ndisallowedTools: Write, Edit\n---\n본문: 콜론 포함 문장. 그리고 --- 구분선도 본문이다.`);
  assert.equal(r.name, 'themis');
  assert.equal(r.model, 'sonnet');
  assert.equal(r.disallowedTools, 'Write, Edit');
  assert.ok(r.systemPrompt.includes('--- 구분선도 본문'));
});

test('parseAgentMd: frontmatter 없음 → throw', () => {
  assert.throws(() => parseAgentMd('# 그냥 마크다운'), /frontmatter 없음/);
});

test('parseAgentMd: model 필드 없음 → throw', () => {
  assert.throws(() => parseAgentMd('---\nname: x\n---\n본문'), /model 필드 없음/);
});

test('parseAgentMd: 본문 비어있음 → throw', () => {
  assert.throws(() => parseAgentMd('---\nmodel: haiku\n---\n\n'), /본문.*비어있음/);
});

test('parseAgentMd: 중첩 YAML(콜론 없는 리스트 줄) → 손상으로 throw', () => {
  assert.throws(() => parseAgentMd('---\nmodel: sonnet\ntools:\n  - Write\n---\n본문'), /형식 오류/);
});

test('loadAgent: 정상 파일 → model·systemPrompt, warning=null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-'));
  try {
    writeFileSync(join(dir, 'athena.md'), VALID);
    const r = loadAgent('athena', { fallbackModel: 'sonnet', dir });
    assert.equal(r.model, 'sonnet');
    assert.ok(r.systemPrompt.includes('투자전략실'));
    assert.equal(r.warning, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('[핵심 계약] loadAgent: 파일 없음 → throw 없이 폴백+warning', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-'));
  try {
    const r = loadAgent('zeus', { fallbackModel: 'opus', dir });
    assert.equal(r.model, 'opus');
    assert.equal(r.systemPrompt, '');
    assert.match(r.warning, /손상\/누락: zeus/);
    assert.match(r.warning, /기본값\(opus\)/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('[핵심 계약] loadAgent: frontmatter 손상 → throw 없이 폴백+warning', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-'));
  try {
    writeFileSync(join(dir, 'themis.md'), '---\nname only no colon field\n---\n본문');
    const r = loadAgent('themis', { fallbackModel: 'sonnet', dir });
    assert.equal(r.model, 'sonnet');
    assert.equal(r.systemPrompt, '');
    assert.ok(r.warning);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('실제 리포지토리 판테온 5개 파일이 모두 파싱되고 모델이 설계와 일치', () => {
  // 설계 정본: 계획 v2 — zeus=opus, athena/themis/apollo=sonnet, hermes=haiku.
  const expected = { zeus: 'opus', athena: 'sonnet', themis: 'sonnet', hermes: 'haiku', apollo: 'sonnet' };
  for (const [name, model] of Object.entries(expected)) {
    const r = loadAgent(name, { fallbackModel: 'FALLBACK-SHOULD-NOT-BE-USED' });
    assert.equal(r.warning, null, `${name}: ${r.warning}`);
    assert.equal(r.model, model, `${name} 모델 불일치`);
    assert.ok(r.systemPrompt.length > 50, `${name} 본문이 비정상적으로 짧음`);
  }
});
