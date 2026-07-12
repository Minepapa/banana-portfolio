import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEvalObj, parseEvalJson, buildRow } from './drain-eval-queue.mjs';

// 라이브 --auto 실행에서 헤드리스 Claude가 실제로 낸 playbook 스키마 출력.
// risks가 "1)…2)…" 문자열, axes 키가 "재무 안정성", reasons 대신 rationale 등 —
// 이전엔 normalizeEvalObj 조기반환으로 toList를 건너뛰어 joinNum(문자열)이 터졌다.
const PLAYBOOK_JSON = {
  date: '2026-06-12', name: 'SK하이닉스', ticker: '000660', market: 'KR',
  conclusion: '🟢 유효', status: '보류',
  axes: { 수익성: '🟢', '재무 안정성': '🟢', 밸류에이션: '🟢', 현금흐름: '🟡', 모멘텀: '🟡' },
  rationale: '1) 영업이익률 71.5%. 2) Forward PER 5.17x. 3) 부채비율 35.6% + ROE 28.3%.',
  risks: '1) FCF yield 1.7%. 2) 52주 위치 87.3% 상단.',
  frankAction: '홀딩 — 위탁 배분 초과로 추가매수 조건 미충족.',
  aiOneliner: 'Forward PER 5.17 + 영업이익률 71.5% — HBM 업사이클 펀더멘털 압도적',
  axisItems: {},
};

test('normalizeEvalObj: playbook 스키마(risks 문자열) — joinNum 크래시 회귀 방지', () => {
  const obj = normalizeEvalObj(PLAYBOOK_JSON);
  assert.ok(Array.isArray(obj.reasons), 'rationale → reasons 배열');
  assert.ok(Array.isArray(obj.risks), 'risks 문자열 → 배열');
  assert.ok(Array.isArray(obj.actions), 'frankAction → actions 배열');
  assert.equal(obj.risks.length, 2);
  assert.equal(obj.reasons.length, 3);
});

test('normalizeEvalObj: axes "재무 안정성" → grades.안정성 정규화', () => {
  const obj = normalizeEvalObj(PLAYBOOK_JSON);
  assert.equal(obj.grades.안정성, '🟢');
  assert.equal(obj.grades.수익성, '🟢');
  assert.equal(obj.grades.모멘텀, '🟡');
});

test('normalizeEvalObj: aiOneliner → aiNote 매핑', () => {
  const obj = normalizeEvalObj(PLAYBOOK_JSON);
  assert.ok(obj.aiNote.includes('Forward PER 5.17'));
});

test('buildRow: playbook 스키마 → 행 조립 성공(터지지 않음), nodeAxis 우선', () => {
  const obj = normalizeEvalObj(PLAYBOOK_JSON);
  const nodeAxis = { 수익성: [{ label: '영업이익률', value: '71.5%', source: 'OpenDart', metric: 'operating_margin' }] };
  const row = buildRow(obj, nodeAxis);
  assert.equal(row[1], 'SK하이닉스');
  assert.equal(row[5], '🟢'); // grades.수익성
  assert.equal(row[6], '🟢'); // grades.안정성 (재무 안정성에서 정규화)
  assert.ok(row[10].includes('영업이익률')); // reasons joinNum
  assert.ok(row[11].includes('FCF yield')); // risks joinNum (문자열→배열)
  assert.equal(JSON.parse(row[20]).수익성[0].metric, 'operating_margin'); // nodeAxis 우선
});

test('parseEvalJson: ```json 펜스 안의 playbook JSON 파싱 + 정규화', () => {
  const raw = '평가 카드입니다.\n\n```json\n' + JSON.stringify(PLAYBOOK_JSON) + '\n```\n끝.';
  const obj = parseEvalJson(raw);
  assert.equal(obj.name, 'SK하이닉스');
  assert.ok(Array.isArray(obj.risks));
  assert.equal(obj.grades.안정성, '🟢');
});

test('parseEvalJson: trailing comma 허용', () => {
  const json = '{ "date":"2026-06-20", "name":"테슬라", "conclusion":"🟡 관망", "reasons":["a",], "risks":["b",], }';
  const raw = '분석:\n```json\n' + json + '\n```';
  const obj = parseEvalJson(raw);
  assert.equal(obj.name, '테슬라');
  assert.deepEqual(obj.reasons, ['a']);
});

test('parseEvalJson: 복수 ```json 펜스 시 마지막 블록 사용', () => {
  const schema = '```json\n{"date":"YYYY-MM-DD","name":"예시"}\n```';
  const real = '```json\n{"date":"2026-06-20","name":"삼성전자","conclusion":"🟢 매수적극","reasons":["a"],"risks":["b"]}\n```';
  const raw = '스키마 예시:\n' + schema + '\n\n실제 출력:\n' + real;
  const obj = parseEvalJson(raw);
  assert.equal(obj.name, '삼성전자');
  assert.equal(obj.date, '2026-06-20');
});

test('normalizeEvalObj: evaluatedAt/stockName 별칭 → date/name', () => {
  const obj = normalizeEvalObj({
    evaluatedAt: '2026-06-20', stockName: '아마존', conclusion: '🟢 유효',
    reasons: ['a'], risks: ['b'],
  });
  assert.equal(obj.date, '2026-06-20');
  assert.equal(obj.name, '아마존');
});

test('normalizeEvalObj: evaluationDate/aiComment/영문 axes 별칭', () => {
  const obj = normalizeEvalObj({
    evaluationDate: '2026-06-20', name: '삼성바이오로직스', conclusion: '🟡 관망',
    axes: { profitability: '🟢', stability: '🟡', valuation: '🔴', cashflow: '🟡', momentum: '🟢' },
    rationale: '1) a 2) b', risks: '1) c', frankAction: '홀딩',
    aiComment: 'CDMO 최상위',
  });
  assert.equal(obj.date, '2026-06-20');
  assert.equal(obj.grades.수익성, '🟢');
  assert.equal(obj.grades.안정성, '🟡');
  assert.equal(obj.grades.밸류에이션, '🔴');
  assert.equal(obj.grades.현금흐름, '🟡');
  assert.equal(obj.grades.모멘텀, '🟢');
  assert.equal(obj.aiNote, 'CDMO 최상위');
});

test('normalizeEvalObj: 한글 스키마(근거/리스크/frank_액션)도 그대로 동작', () => {
  const obj = normalizeEvalObj({
    평가일: '2026-06-12', 종목명: '삼성전자', 결론: '🟢 유효',
    근거: '1) a 2) b', 리스크: '1) c', frank_액션: '홀딩',
    수익성: '🟢', 안정성: '🟡',
  });
  assert.equal(obj.reasons.length, 2);
  assert.equal(obj.risks.length, 1);
  assert.equal(obj.grades.수익성, '🟢');
  assert.equal(obj.grades.안정성, '🟡');
});

// ── LLM 출력 하네스 (2026-07 성향관찰 사고 대응) ────────────────────────────

test('parseEvalJson: 결론에 이모지 없으면 카드 전체 폐기(throw)', () => {
  const raw = '```json\n{"date":"2026-06-20","name":"테슬라","conclusion":"매수적극","reasons":["a"],"risks":["b"]}\n```';
  assert.throws(() => parseEvalJson(raw), /결론 이모지 불명/);
});

test('parseEvalJson: 결론이 이모지로 시작하면 정상 통과', () => {
  const raw = '```json\n{"date":"2026-06-20","name":"테슬라","conclusion":"🟢 매수적극","reasons":["a"],"risks":["b"]}\n```';
  const obj = parseEvalJson(raw);
  assert.equal(obj.conclusion, '🟢 매수적극');
});

test('normalizeGrades: 등급값에 신호 이모지 없으면 그 축은 드롭("좋음" 같은 자유텍스트 차단)', () => {
  const obj = normalizeEvalObj({
    date: '2026-06-20', name: '삼성전자', conclusion: '🟢 유효',
    axes: { 수익성: '좋음', 안정성: '🟢', 밸류에이션: '🟡' },
    reasons: ['a'], risks: ['b'],
  });
  assert.equal(obj.grades.수익성, undefined);   // 이모지 없어 드롭
  assert.equal(obj.grades.안정성, '🟢');         // 이모지 있어 유지
  assert.equal(obj.grades.밸류에이션, '🟡');
});

test('buildRow: 드롭된 축은 빈 문자열로(정직한 미평가, 크래시 없음)', () => {
  const obj = normalizeEvalObj({
    date: '2026-06-20', name: '삼성전자', conclusion: '🟢 유효',
    axes: { 수익성: '좋음', 안정성: '🟢' },
    reasons: ['a'], risks: ['b'],
  });
  const row = buildRow(obj, null);
  assert.equal(row[5], '');       // 수익성 드롭 → 빈칸
  assert.equal(row[6], '🟢');     // 안정성 유지
});
