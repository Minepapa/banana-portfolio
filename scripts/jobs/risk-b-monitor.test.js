import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter } from '../lib/vault-frontmatter.mjs';
import { buildLogicPrompt, buildRiskRecord } from './risk-b-monitor.mjs';

const FACTS = { source: 'OpenDart 2026 1분기보고서(연결)', grossMargin: 61.19, opMargin: 42.8, roe: 19.3 };

test('buildLogicPrompt: 검증된 펀더멘털 JSON을 있는 그대로 포함(재계산 금지 지시와 함께)', () => {
  const prompt = buildLogicPrompt({ name: '삼성전자', market: 'KR' }, FACTS, [], null, null);
  assert.match(prompt, /종목: 삼성전자 \(KR\)/);
  assert.match(prompt, /"grossMargin": 61.19/);
  assert.match(prompt, /절대 재조회·재계산·추정하지 말 것/);
});

test('buildLogicPrompt: 가드레일 트리거 있으면 "신호는 최소 🟡" 문구 포함', () => {
  const prompt = buildLogicPrompt({ name: '삼성전자', market: 'KR' }, FACTS, ['부채비율 고위험'], null, null);
  assert.match(prompt, /부채비율 고위험 → 신호는 최소 🟡/);
});

test('buildLogicPrompt: 가드레일 없으면 "트리거 없음"', () => {
  const prompt = buildLogicPrompt({ name: '삼성전자', market: 'KR' }, FACTS, [], null, null);
  assert.match(prompt, /가드레일 사전판정\(시스템 계산\)\] 트리거 없음/);
});

test('buildLogicPrompt: 기준선 없으면 "절대 평가" 폴백 문구', () => {
  const prompt = buildLogicPrompt({ name: '삼성전자', market: 'KR' }, FACTS, [], null, null);
  assert.match(prompt, /\[저장된 기준선\] 없음 — 주입된 펀더멘털만으로 절대 평가/);
});

test('buildLogicPrompt: 기준선 있으면 4개 지표 인용', () => {
  const baseline = {
    baselineDate: '2026-06-13', grossMargin: '61.19%', operatingMargin: '42.80%',
    roe: '19.30%', debtRatio: '30.15%', eps: '데이터 부족', pbr: '4.35', note: '메모',
  };
  const prompt = buildLogicPrompt({ name: '삼성전자', market: 'KR' }, FACTS, [], baseline, null);
  assert.match(prompt, /저장된 기준선 \(2026-06-13\)/);
  assert.match(prompt, /ROE 19.30%/);
});

test('buildLogicPrompt: PositionJournal 없으면 "기준선 대비 변화만 판단" 폴백', () => {
  const prompt = buildLogicPrompt({ name: '삼성전자', market: 'KR' }, FACTS, [], null, null);
  assert.match(prompt, /\[매수 논리\] PositionJournal에 없음 — 기준선 대비 변화만 판단/);
});

test('buildLogicPrompt: PositionJournal 있으면 thesis·exitCondition 인용(전제 파괴 기준)', () => {
  const journal = { updatedAt: '2026-06-08', kind: '확신', thesis: 'HBM4 마진 회복', exitCondition: 'DS 마진 재악화' };
  const prompt = buildLogicPrompt({ name: '삼성전자', market: 'KR' }, FACTS, [], null, journal);
  assert.match(prompt, /근거: HBM4 마진 회복/);
  assert.match(prompt, /매도 조건\(전제 파괴 기준\): DS 마진 재악화/);
});

test('buildRiskRecord: frontmatter 필드가 result를 정확히 반영', () => {
  const result = {
    name: '삼성전자', signal: '🟢', summary: '요약', detail: '상세',
    facts: { roe: 19.3 }, baselineRef: '2026-06-13',
  };
  const now = new Date('2026-08-14T13:48:55.307Z');
  const { filename, content } = buildRiskRecord(result, now);
  assert.equal(filename, '삼성전자-20260814T134855Z.md');
  const fm = parseFrontmatter(content);
  assert.equal(fm.type, 'risk-judgment');
  assert.equal(fm.riskType, 'B');
  assert.equal(fm.target, '삼성전자');
  assert.equal(fm.signal, '🟢');
  assert.equal(fm.baselineRef, '2026-06-13');
  assert.deepEqual(JSON.parse(fm.evidenceJson), { roe: 19.3 });
});

test('buildRiskRecord: 종목명에 경로 위험 문자가 있어도 파일명이 안전하게 정제됨', () => {
  const result = { name: '알파벳/Class A', signal: '🟡', summary: '', detail: '', facts: {}, baselineRef: '없음' };
  const { filename } = buildRiskRecord(result, new Date('2026-08-14T00:00:00.000Z'));
  assert.doesNotMatch(filename, /\//);
  assert.match(filename, /^알파벳_Class-A-20260814T000000Z\.md$/);
});
