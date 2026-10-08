import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_NAMES, buildAgentDefs, renderAgent } from './build-agent-defs.mjs';
import { LEGACY_OVERRIDES, AGENT_SPECIFIC_OVERRIDES, APPENDIX_OVERRIDES, COMMON_OVERRIDES } from './agent-legacy-overrides.mjs';
import { parseAgentMd } from '../lib/agent-loader.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agent-defs-'));
  const charterDir = join(root, 'charters');
  const archiveDir = join(root, 'archive');
  const outDir = join(root, 'output');
  for (const dir of [charterDir, archiveDir, outDir]) mkdirSync(dir);
  writeFileSync(join(charterDir, '판테온 공통 헌장.md'), '---\nname: pantheon\n---\n# 판테온 공통 헌장\n\n공통 판단 기준.\n');
  for (const name of AGENT_NAMES) {
    const legacyAppendix = name === 'zeus' ? '["[[80_Archive/agents-2026-10-08/zeus]]"]' : '[]';
    const sections = ['신화적 원형', '사명', '성격', '말투', '책임', '경계', '작업 유형별 절차', '협업', '개별 금지']
      .map((heading, index) => `## ${index + 1}. ${heading}\n\n개별 판단 기준.`).join('\n\n');
    writeFileSync(join(charterDir, `${name}.md`), `---\nname: "${name}"\ntitle: "제목"\ndescription: "업무 설명"\nroutingHint: "요청 내용"\nroutingKeywords: ["키워드"]\nruntimeModel: "sonnet"\ntools: "Read, Grep"\nlegacyAppendix: ${legacyAppendix}\n---\n# ${name}\n\n${sections}\n\n## 변경 이력\n\n- 생성.\n`);
  }
  writeFileSync(join(archiveDir, 'zeus.md'), '---\nname: zeus\n---\n# 옛 Zeus\n\n비서실이 텔레그램 즉시 1줄 + 주간리포트.\n\n## 텔레그램 상시세션 프로토콜\n제거할 규칙.\n\n## 운영 규칙\n보존할 규칙.\n');
  return { routeOut: join(root, 'route-keywords.generated.json'), root, charterDir, archiveDir, outDir };
}

test('헌장 머리말·공통 본문·옛 지침을 생성하고 텔레그램 절만 대체한다', () => {
  const dirs = fixture();
  try {
    const text = renderAgent('zeus', dirs);
    const parsed = parseAgentMd(text);
    assert.equal(parsed.name, 'zeus');
    assert.equal(parsed.model, 'sonnet');
    assert.match(text, /^description: ".*이럴 때 사용: .*"$/m);
    assert.match(parsed.description, /스폰하지 말 것/);
    assert.match(parsed.systemPrompt, /판테온 공통 헌장/);
    assert.match(parsed.systemPrompt, /제우스가 텔레그램 즉시 1줄/);
    assert.match(parsed.systemPrompt, /텔레그램 운영 규칙은/);
    assert.match(parsed.systemPrompt, /보존할 규칙/);
    assert.doesNotMatch(parsed.systemPrompt, /제거할 규칙/);
  } finally { rmSync(dirs.root, { recursive: true, force: true }); }
});

test('본문 9섹션이나 부록 경계가 손상되면 생성 전에 멈추고 기존 파일을 보존한다', () => {
  const dirs = fixture();
  try {
    buildAgentDefs(dirs);
    const outputPath = join(dirs.outDir, 'zeus.md');
    const original = readFileSync(outputPath, 'utf8');
    const charterPath = join(dirs.charterDir, 'plutus.md');
    writeFileSync(charterPath, readFileSync(charterPath, 'utf8').replace('## 5. 책임', '## 5. 손상'));
    assert.throws(() => buildAgentDefs(dirs), /헌장 본문 9섹션 손상/);
    assert.equal(readFileSync(outputPath, 'utf8'), original);
    writeFileSync(charterPath, readFileSync(charterPath, 'utf8').replace('## 5. 손상', '## 5. 책임').replace('## 변경 이력', '## 부록'));
    assert.throws(() => buildAgentDefs(dirs), /헌장 부록 경계 손상/);
    assert.equal(readFileSync(outputPath, 'utf8'), original);
  } finally { rmSync(dirs.root, { recursive: true, force: true }); }
});

test('--check는 불일치를 보고하고 파일을 고치지 않는다', () => {
  const dirs = fixture();
  try {
    assert.equal(buildAgentDefs(dirs).differences.length, 7); // 정의 6개 + 라우팅 키워드 파일(이관 4-5)
    assert.deepEqual(buildAgentDefs({ ...dirs, check: true }).differences, []);
    const path = join(dirs.outDir, 'plutus.md');
    writeFileSync(path, 'stale');
    assert.deepEqual(buildAgentDefs({ ...dirs, check: true }).differences, ['plutus.md']);
    assert.equal(readFileSync(path, 'utf8'), 'stale');
  } finally { rmSync(dirs.root, { recursive: true, force: true }); }
});

test('Agents 폴더가 없으면 오류', () => {
  const dirs = fixture();
  try {
    assert.throws(() => renderAgent('zeus', { ...dirs, charterDir: join(dirs.root, 'missing') }), /Agents 폴더 없음/);
  } finally { rmSync(dirs.root, { recursive: true, force: true }); }
});

test('부록 보정표는 문장별이고 현행 역할 지시·라벨을 보존한다', () => {
  assert.ok(LEGACY_OVERRIDES.length > 20);
  assert.ok(Object.values(AGENT_SPECIFIC_OVERRIDES).every((entries) => entries.every(([from, to]) => from && to)));
  const zeus = renderAgent('zeus');
  const clio = renderAgent('clio');
  const plutus = renderAgent('plutus');
  const themis = renderAgent('themis');
  assert.match(zeus, /플루토스\(투자 판단·장부 신뢰도·기준일\), 테미스\(제안 2차 검증/);
  assert.match(zeus, /성향 관찰은 클리오가 정리·승격 제안하고 오너가 확정한다/);
  assert.doesNotMatch(zeus, /Zeus 결정·즉시 실행.*성향 갱신/);
  assert.match(zeus, /텔레그램 세션.*"개인" 등급 노트를 읽거나 원문 중계하지 않고/);
  assert.doesNotMatch(zeus, /\| (투자전략실 Athena|퀀트전략실 Kairos|운영실 Hermes|비서실 Apollo) \|/);
  assert.match(clio, /\[클리오 Clio\] 라벨만 유지한다/);
  assert.doesNotMatch(clio, /\[플루토스 Plutus\] 라벨만 유지한다/);
  assert.doesNotMatch(plutus, /\[(투자전략실 Athena|퀀트전략실 Kairos|운영실 Hermes|비서실 Apollo)\] 라벨만 유지한다/);
  assert.match(themis, /플루토스 제안의 2차 검증/);
  assert.match(themis, /자동 체결·포지션 상시 감시는 플루토스 소관/);
  assert.doesNotMatch(themis, /플루토스의 상시 감시 결과를 2차 검증/);
  assert.ok(COMMON_OVERRIDES.length > 0);
  assert.ok(APPENDIX_OVERRIDES['plutus:themis'].length > 0);
  for (const agent of [zeus, clio, plutus, themis, renderAgent('athena')]) {
    assert.match(agent, /텔레그램 세션.*"개인" 등급 노트를 읽거나 원문 중계하지 않는다/);
    assert.doesNotMatch(agent, /중계만\*\* 한다\(원문 그대로/);
  }
  assert.doesNotMatch(clio, /profile\/kpi_baseline|reports\/|로컬 파일\(KPI·주간리포트\)|Zeus 결정 사후 보고를 조립·발송한다/);
  assert.match(clio, /성향 관찰 사실은 Vault 정본 또는 Node factsText만/);
  assert.doesNotMatch(clio, /즉시 확정 경로|확정\/기각은 Zeus 결정 게이트/);
  assert.match(plutus, /성향 학습·관찰 추출은 클리오 소관/);
  assert.doesNotMatch(plutus, /Zeus 결정 사후 보고 조립·발송|성향 기록 규칙 \(헌장|로컬 파일\(KPI·주간리포트\)/);
  assert.match(plutus, /상시 위험 감시 보고에는 신호 원문·근거·심각도/);
  assert.doesNotMatch(plutus, /플루토스 제안에 대한 동의\/이견을 판정하라|\[플루토스 Plutus\] 라벨만 유지한다\. 정해진 첫 문장·틀은 없다 — 저울/);
});

test('생성된 지침에 남은 옛 이름 줄 목록은 리뷰된 스냅숏과 같다', () => {
  const oldRole = /Athena|Kairos|Hermes|Apollo|투자전략실|퀀트전략실|운영실|비서실|리스크관리실|카이로스|아폴로/;
  const lines = AGENT_NAMES.flatMap((name) => renderAgent(name).split('\n')
    .flatMap((line, index) => oldRole.test(line) ? [`.claude/agents/${name}.md:${index + 1}:${line}`] : []));
  const snapshotPath = join(dirname(fileURLToPath(import.meta.url)), 'agent-legacy-lines.snapshot.txt');
  assert.equal(`${lines.join('\n')}\n`, readFileSync(snapshotPath, 'utf8'));
});
