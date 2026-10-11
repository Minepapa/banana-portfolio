// 에이전트 정의 로더 테스트 — 판테온 조직 개편(2026-07-15)의 계약 검증.
// 핵심 계약: (1) parseAgentMd 는 flat frontmatter 만 허용, 어긋나면 throw.
// (2) loadAgent 는 절대 throw 하지 않는다 — 손상/누락 시 폴백 모델 + warning 반환
//     (무인 잡이 에이전트 파일 문제로 죽거나, 조용히 잘못된 모델로 도는 것 둘 다 방지).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { parseAgentMd, loadAgent } from './agent-loader.mjs';

const VALID = `---
name: plutus
description: 플루토스 — 평가·주문서 초안
model: sonnet
---

# Plutus — 자산

책임: 5축 평가. 경계: 제안까지만.
`;

const WITH_APPENDICES = `${VALID.trimEnd()}

## 부록 — 구 부서 정의에서 이관한 상세 지침

### 구 athena 지침

자산분배만 담당.

## 내부 소제목
자산분배 상세.

### 구 kairos 지침

퀀트만 담당.

### 구 themis 지침

위험만 담당.
`;

const NEW_APPENDICES = WITH_APPENDICES.replace('### 구 athena 지침',
  '### 2026-10-08 이전 구 athena 지침 (현행 헌장 우선)');

test('parseAgentMd: 정상 파일 — 필드·본문 추출', () => {
  const r = parseAgentMd(VALID);
  assert.equal(r.name, 'plutus');
  assert.equal(r.model, 'sonnet');
  assert.ok(r.systemPrompt.startsWith('# Plutus'));
  assert.ok(r.systemPrompt.includes('경계: 제안까지만.'));
});

test('parseAgentMd: CRLF 줄바꿈 허용', () => {
  const r = parseAgentMd(VALID.replace(/\n/g, '\r\n'));
  assert.equal(r.model, 'sonnet');
  assert.ok(r.systemPrompt.includes('Plutus'));
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
    writeFileSync(join(dir, 'plutus.md'), VALID);
    const r = loadAgent('plutus', { fallbackModel: 'sonnet', dir });
    assert.equal(r.model, 'sonnet');
    assert.ok(r.systemPrompt.includes('자산'));
    assert.equal(r.warning, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('loadAgent: appendix 생략은 전체 부록을 유지한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-'));
  try {
    writeFileSync(join(dir, 'plutus.md'), WITH_APPENDICES);
    const result = loadAgent('plutus', { fallbackModel: 'sonnet', dir });
    for (const name of ['athena', 'kairos', 'themis']) assert.match(result.systemPrompt, new RegExp(`### 구 ${name} 지침`));
    assert.equal(result.warning, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('loadAgent: 지정한 부록 하나 또는 여러 개만 남긴다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-'));
  try {
    writeFileSync(join(dir, 'plutus.md'), WITH_APPENDICES);
    const single = loadAgent('plutus', { fallbackModel: 'sonnet', dir, appendix: ['athena'] });
    assert.match(single.systemPrompt, /자산분배 상세/);
    assert.doesNotMatch(single.systemPrompt, /퀀트만|위험만/);
    const multiple = loadAgent('plutus', { fallbackModel: 'sonnet', dir, appendix: ['athena', 'themis'] });
    assert.match(multiple.systemPrompt, /자산분배 상세/);
    assert.match(multiple.systemPrompt, /위험만 담당/);
    assert.doesNotMatch(multiple.systemPrompt, /퀀트만 담당/);
    assert.equal(multiple.warning, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('loadAgent: 날짜와 설명이 붙은 새 부록 제목을 인식한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-'));
  try {
    writeFileSync(join(dir, 'plutus.md'), NEW_APPENDICES);
    const result = loadAgent('plutus', { fallbackModel: 'opus', dir, appendix: ['athena'] });
    assert.equal(result.model, 'sonnet');
    assert.match(result.systemPrompt, /# Plutus/);
    assert.match(result.systemPrompt, /### 2026-10-08 이전 구 athena 지침 \(현행 헌장 우선\)/);
    assert.doesNotMatch(result.systemPrompt, /퀀트만|위험만/);
    assert.equal(result.warning, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('loadAgent: 일부 부록이 없으면 헌장과 찾은 부록을 유지하고 경고한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-'));
  try {
    writeFileSync(join(dir, 'plutus.md'), WITH_APPENDICES);
    const result = loadAgent('plutus', { fallbackModel: 'opus', dir, appendix: ['athena', 'apollo'] });
    assert.equal(result.model, 'sonnet');
    assert.match(result.systemPrompt, /# Plutus/);
    assert.match(result.systemPrompt, /자산분배만 담당/);
    assert.doesNotMatch(result.systemPrompt, /퀀트만|위험만/);
    assert.match(result.warning, /부록 지침 없음: plutus — apollo/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('loadAgent: 부록 전체 또는 경계가 없어도 헌장을 유지한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-'));
  try {
    writeFileSync(join(dir, 'plutus.md'), WITH_APPENDICES);
    const missing = loadAgent('plutus', { fallbackModel: 'opus', dir, appendix: ['apollo'] });
    assert.equal(missing.model, 'sonnet');
    assert.match(missing.systemPrompt, /# Plutus/);
    assert.doesNotMatch(missing.systemPrompt, /### 구/);
    assert.match(missing.warning, /부록 지침 없음/);

    writeFileSync(join(dir, 'plutus.md'), VALID);
    const noBoundary = loadAgent('plutus', { fallbackModel: 'opus', dir, appendix: ['athena'] });
    assert.equal(noBoundary.model, 'sonnet');
    assert.match(noBoundary.systemPrompt, /# Plutus/);
    assert.match(noBoundary.warning, /부록 지침 없음/);
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
  // 설계 정본: zeus=opus, athena/themis/apollo=sonnet, hermes=sonnet(2026-07-18 haiku→sonnet 승격, 서술 품질).
  const expected = { zeus: 'opus', clio: 'sonnet', themis: 'sonnet', hermes: 'sonnet', athena: 'sonnet', plutus: 'sonnet' };
  for (const [name, model] of Object.entries(expected)) {
    const r = loadAgent(name, { fallbackModel: 'FALLBACK-SHOULD-NOT-BE-USED' });
    assert.equal(r.warning, null, `${name}: ${r.warning}`);
    assert.equal(r.model, model, `${name} 모델 불일치`);
    assert.ok(r.systemPrompt.length > 50, `${name} 본문이 비정상적으로 짧음`);
  }
});

test('scripts의 모든 appendix 요청은 실제 에이전트 정의에 존재한다', () => {
  const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), '..');
  const agentsDir = join(scriptsDir, '..', '.claude', 'agents');
  const requests = [];

  function visit(node, callback) {
    if (!node || typeof node !== 'object') return;
    if (node.type) callback(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach((item) => visit(item, callback));
      else if (value && typeof value === 'object') visit(value, callback);
    }
  }

  function staticMap(object) {
    assert.equal(object?.type, 'ObjectExpression');
    return Object.fromEntries(object.properties.map((property) => {
      assert.equal(property.type, 'Property');
      assert.equal(property.value.type, 'Literal');
      return [property.key.name ?? property.key.value, property.value.value];
    }));
  }

  function scan(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { scan(path); continue; }
      if (!entry.name.endsWith('.mjs')) continue;
      const source = readFileSync(path, 'utf8');
      const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
      const file = relative(scriptsDir, path);
      const declarations = [];
      const calls = [];
      visit(ast, (node) => {
        if (node.type === 'VariableDeclarator') declarations.push(node);
        if (node.type === 'CallExpression' && node.callee.name === 'loadAgent') calls.push(node);
      });
      for (const call of calls) {
        const options = call.arguments[1];
        if (options?.type !== 'ObjectExpression') continue;
        const appendix = options.properties.find((property) => property.key?.name === 'appendix');
        if (!appendix) continue;
        assert.equal(appendix.value.type, 'ArrayExpression', `${file}: appendix 배열을 정적으로 확인할 수 없음`);
        const names = appendix.value.elements;
        const agent = call.arguments[0];
        if (agent.type === 'Literal' && names.every((name) => name.type === 'Literal')) {
          requests.push({ file, agent: agent.value, appendices: names.map((name) => name.value) });
          continue;
        }
        // 상담 경로는 부서별 에이전트와 부록을 두 개의 정적 맵으로 선택한다.
        assert.equal(file, 'jobs/intraday-market-move-monitor.mjs', `${file}: 동적 appendix 요청 검토 필요`);
        assert.equal(agent.name, 'agentKey');
        assert.deepEqual(names.map((name) => name.name), ['consultationAppendix']);
        const agentsMap = staticMap(declarations.find((declaration) => declaration.id.name === 'CONSULT_AGENTS')?.init);
        const appendixMap = staticMap(declarations.find((declaration) => declaration.id.name === 'consultationAppendix')?.init?.object);
        assert.deepEqual(Object.keys(agentsMap).sort(), Object.keys(appendixMap).sort());
        for (const department of Object.keys(agentsMap)) {
          requests.push({ file, agent: agentsMap[department], appendices: [appendixMap[department]] });
        }
      }
    }
  }

  scan(scriptsDir);
  assert.ok(requests.length > 0, 'appendix 요청을 찾지 못함');
  for (const { file, agent, appendices } of requests) {
    const definition = readFileSync(join(agentsDir, `${agent}.md`), 'utf8');
    for (const name of appendices) {
      const headings = [...definition.matchAll(/^### (?:\d{4}-\d{2}-\d{2} 이전 )?구 ([a-z]+) 지침(?:[ \t]*\([^\r\n]*\))?[ \t]*$/gm)];
      assert.ok(headings.some((heading) => heading[1] === name), `${file}: ${agent} → ${name} 부록 지침 없음`);
    }
  }
});
