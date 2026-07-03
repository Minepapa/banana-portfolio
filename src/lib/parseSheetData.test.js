// parseSheetData.js 회귀 방지 테스트.
// 내부 파서는 export 없으므로 parseSheetData 진입점 경유 검증.
// 핵심: 날짜 시리얼 방어, 최신순 정렬, 집계, 필터.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSheetData } from './parseSheetData.js';

// 구글 시트 날짜 시리얼 → YYYY-MM-DD: 46190 = 2026-06-17
// (25569 = epoch 기준일, 각 단위 = 1일)
const SERIAL_20260617 = 46190;

// 최소 계좌 행 (현금성 예수금): 인덱스 0–8 = [자산군, 종목명, 단가, 수량, 투자금, 현재가, 수익, 평가, 수익률]
const CASH_ROW = ['현금성', '예수금', '0', '1', '1000000', '1000000', '0', '1000000', '0'];

// 빈 valueRanges 슬롯
const EMPTY = { values: [] };
const makeVR = (len = 19) => Array(len).fill(EMPTY);

// ── 기본 ──────────────────────────────────────────────────

test('빈 valueRanges → null (계좌 데이터 없음)', () => {
  assert.strictEqual(parseSheetData(makeVR()), null);
});

test('계좌 보유 종목 기본 파싱 — 합계·수익 계산', () => {
  const vrs = makeVR();
  vrs[1] = { values: [
    ['국내주식', '삼성전자', '70000', '10', '700000', '75000', '50000', '750000', '7.14'],
  ] };
  const result = parseSheetData(vrs);
  assert.ok(result);
  const 위탁 = result.accounts['위탁'];
  assert.ok(위탁);
  assert.equal(위탁.holdings.length, 1);
  assert.equal(위탁.holdings[0].name, '삼성전자');
  assert.equal(위탁.holdings[0].invest, 700000);
  assert.equal(위탁.holdings[0].eval, 750000);
  assert.equal(위탁.total_invest, 700000);
  assert.equal(위탁.total_eval, 750000);
  assert.equal(위탁.profit, 50000);
});

test('복수 계좌 데이터 → accounts에 각 키가 생성됨', () => {
  const vrs = makeVR();
  vrs[0] = { values: [CASH_ROW] };      // ISA
  vrs[1] = { values: [CASH_ROW] };      // 위탁
  vrs[2] = { values: [CASH_ROW] };      // 연금저축
  const result = parseSheetData(vrs);
  assert.ok(result);
  assert.ok(result.accounts['ISA']);
  assert.ok(result.accounts['위탁']);
  assert.ok(result.accounts['연금저축']);
  assert.equal(result.accounts['IRP'], undefined);  // 데이터 없으면 키 없음
});

// ── 날짜 시리얼 방어 ─────────────────────────────────────
// 구글 시트 USER_ENTERED 쓰기 후 셀이 시리얼로 저장되는 케이스.
// 이 클래스 버그가 실제로 risk-monitor 6/17 카드 소실 원인(pruneRiskSheet 오비교).

test('날짜 시리얼 방어: parseDividends — 시리얼 → YYYY-MM-DD', () => {
  const vrs = makeVR();
  vrs[1] = { values: [CASH_ROW] };
  // 배당금(index 9): [날짜, 금액, 종목명]
  vrs[9] = { values: [[SERIAL_20260617, '50000', '삼성전자']] };
  const result = parseSheetData(vrs);
  assert.ok(result);
  const item = result.dividends[0]?.items[0];
  assert.ok(item, '배당금 항목이 파싱돼야 함');
  assert.equal(item.date, '2026-06-17');
});

test('날짜 시리얼 방어: parseRiskMonitor — 시리얼 → YYYY-MM-DD', () => {
  const vrs = makeVR();
  vrs[1] = { values: [CASH_ROW] };
  // 리스크모니터(index 14): [날짜, 유형, 대상, 신호, 요약, 상세, 근거, 기준선참조]
  vrs[14] = { values: [[SERIAL_20260617, 'D', '거시', '🔴', '요약', '상세', '', '']] };
  const result = parseSheetData(vrs);
  assert.ok(result);
  assert.equal(result.riskMonitor[0]?.date, '2026-06-17');
});

test('날짜 시리얼 방어: parseEvaluations — 시리얼 → YYYY-MM-DD', () => {
  const vrs = makeVR();
  vrs[1] = { values: [CASH_ROW] };
  // 종목투자노트(index 11): [날짜, 종목명, 티커, 시장, 결론, 5축, ...]
  vrs[11] = { values: [[SERIAL_20260617, '삼성전자', '005930', 'KR', '🟢', ...Array(15).fill('')]] };
  const result = parseSheetData(vrs);
  assert.ok(result);
  assert.equal(result.evaluations[0]?.date, '2026-06-17');
});

// ── parseEvaluations ──────────────────────────────────────

test('parseEvaluations: 최신순 정렬', () => {
  const vrs = makeVR();
  vrs[1] = { values: [CASH_ROW] };
  vrs[11] = { values: [
    ['2026-01-15', '삼성전자', '', 'KR', '🟢', ...Array(15).fill('')],
    ['2026-03-10', '카카오', '', 'KR', '🔴', ...Array(15).fill('')],
  ] };
  const result = parseSheetData(vrs);
  const evals = result.evaluations;
  assert.equal(evals.length, 2);
  assert.equal(evals[0].stock.name, '카카오');   // 최신(3월)이 앞
  assert.equal(evals[1].stock.name, '삼성전자');
});

test('normalizeConclusion: 이모지 → 표준 4단계 어휘', () => {
  const vrs = makeVR();
  vrs[1] = { values: [CASH_ROW] };
  vrs[11] = { values: [
    ['2026-01-01', '종목A', '', 'KR', '🟢 뭔가 더 있는 텍스트', ...Array(15).fill('')],
    ['2026-01-02', '종목B', '', 'KR', '🔴', ...Array(15).fill('')],
    ['2026-01-03', '종목C', '', 'KR', '🟡 관망', ...Array(15).fill('')],
    ['2026-01-04', '종목D', '', 'KR', '⚪판단보류', ...Array(15).fill('')],
  ] };
  const { evaluations: evals } = parseSheetData(vrs);
  // reverse: D, C, B, A
  assert.equal(evals[0].conclusion.raw, '⚪ 판단보류');
  assert.equal(evals[1].conclusion.raw, '🟡 관망');
  assert.equal(evals[2].conclusion.raw, '🔴 부적합');
  assert.equal(evals[3].conclusion.raw, '🟢 유효');
});

test('normalizeConclusion: 이모지 없는 텍스트 → 어휘 매핑', () => {
  const vrs = makeVR();
  vrs[1] = { values: [CASH_ROW] };
  vrs[11] = { values: [
    ['2026-01-01', 'A', '', 'KR', '부적합', ...Array(15).fill('')],
    ['2026-01-02', 'B', '', 'KR', '판단 보류', ...Array(15).fill('')],
    ['2026-01-03', 'C', '', 'KR', '관망', ...Array(15).fill('')],
    ['2026-01-04', 'D', '', 'KR', '유효', ...Array(15).fill('')],
  ] };
  const { evaluations: evals } = parseSheetData(vrs);
  // reverse: D, C, B, A
  assert.equal(evals[0].conclusion.raw, '🟢 유효');
  assert.equal(evals[1].conclusion.raw, '🟡 관망');
  assert.equal(evals[2].conclusion.raw, '⚪ 판단보류');
  assert.equal(evals[3].conclusion.raw, '🔴 부적합');
});

test('parseEvaluations: 날짜·종목명 없는 행 필터', () => {
  const vrs = makeVR();
  vrs[1] = { values: [CASH_ROW] };
  vrs[11] = { values: [
    ['', '종목없는날짜', '', 'KR', '🟢', ...Array(15).fill('')],    // 날짜 없음
    ['2026-01-01', '', '', 'KR', '🟢', ...Array(15).fill('')],     // 종목명 없음
    ['2026-01-02', '유효종목', '', 'KR', '🟢', ...Array(15).fill('')], // 정상
  ] };
  const { evaluations: evals } = parseSheetData(vrs);
  assert.equal(evals.length, 1);
  assert.equal(evals[0].stock.name, '유효종목');
});

// ── parseEvalQueue ────────────────────────────────────────

test('parseEvalQueue: 상태별 counts 집계', () => {
  const vrs = makeVR();
  vrs[1] = { values: [CASH_ROW] };
  // 평가요청(index 12): [요청일, 종목명, 시장, 상태, 처리일, 메모]
  vrs[12] = { values: [
    ['2026-06-01', '삼성전자', 'KR', '완료',   '2026-06-02', ''],
    ['2026-06-10', 'AAPL',    'US', '대기',   '',           ''],
    ['2026-06-15', 'NVDA',    'US', '오류',   '',           ''],
    ['2026-06-20', '카카오',  'KR', '',       '',           ''],  // 빈값 → '대기'
    ['2026-06-21', '처리중목','KR', '처리중',  '',           ''],
  ] };
  const { counts } = parseSheetData(vrs).evalQueue;
  assert.equal(counts.done, 1);
  assert.equal(counts.pending, 2);    // '대기' + 빈값
  assert.equal(counts.error, 1);
  assert.equal(counts.processing, 1);
});

test('parseEvalQueue: 최신순 정렬 (역순)', () => {
  const vrs = makeVR();
  vrs[1] = { values: [CASH_ROW] };
  vrs[12] = { values: [
    ['2026-05-01', '오래된종목', 'KR', '완료', '', ''],
    ['2026-06-01', '최신종목',  'KR', '대기', '', ''],
  ] };
  const { entries } = parseSheetData(vrs).evalQueue;
  assert.equal(entries[0].name, '최신종목');
  assert.equal(entries[1].name, '오래된종목');
});

// ── parsePositionJournal ──────────────────────────────────

test('parsePositionJournal: 보유 먼저, 청산 뒤로', () => {
  const vrs = makeVR();
  vrs[1] = { values: [CASH_ROW] };
  // 포지션저널(index 16): [종목명, 티커, 시장, 계좌, 종류, thesis, target, exit, hold, 진입일, 상태, 청산일, ...]
  vrs[16] = { values: [
    ['삼성전자', '005930', 'KR', '위탁', '확신', '', '', '', '', '', '청산', ...Array(5).fill('')],
    ['엔비디아', 'NVDA',   'US', '위탁', '배분', '', '', '', '', '', '보유', ...Array(5).fill('')],
    ['카카오',  '035720', 'KR', '위탁', '확신', '', '', '', '', '', '청산', ...Array(5).fill('')],
  ] };
  const journal = parseSheetData(vrs).positionJournal;
  assert.equal(journal[0].name, '엔비디아');       // 보유 우선
  assert.ok(journal.slice(1).every(j => j.status === '청산'));
});

test('parsePositionJournal: 컬럼 인덱스 계약 고정 (A~P, scripts/lib/sheet-contracts.mjs와 정합)', () => {
  // writer(sync-position-journal HEADER)·다른 reader(behavior-signals JOURNAL_COL)와 같은
  // 레이아웃을 이 파서가 유지하는지 위치별 고유값으로 고정 — 열이 한 칸이라도 밀리면 실패.
  // (src는 scripts를 import할 수 없어 여기서 동일 계약을 독립적으로 핀 — 2026-07 침묵 어긋남 방지)
  const vrs = makeVR();
  vrs[1] = { values: [CASH_ROW] };
  vrs[16] = { values: [[
    '이름0', '티커1', '시장2', '계좌3', '유형4', '전제5', '목표6', '이탈7',
    '보유기간8', '2026-01-09', '청산', '2026-06-11', '결과12', '교훈13', '확인', '갱신15',
  ]] };
  const [p] = parseSheetData(vrs).positionJournal;
  assert.equal(p.name, '이름0');
  assert.equal(p.kind, '유형4');
  assert.equal(p.thesis, '전제5');
  assert.equal(p.exit, '이탈7');
  assert.equal(p.entry, '2026-01-09');    // J열(9)
  assert.equal(p.status, '청산');          // K열(10) — 여기 밀리면 상태를 청산일로 읽는 사고
  assert.equal(p.exitDate, '2026-06-11'); // L열(11)
  assert.equal(p.result, '결과12');        // M열(12)
  assert.equal(p.lesson, '교훈13');        // N열(13)
  assert.equal(p.confirm, '확인');         // O열(14)
  assert.equal(p.updated, '갱신15');       // P열(15)
});

// ── parseDividends ────────────────────────────────────────

test('parseDividends: 같은 월 집계', () => {
  const vrs = makeVR();
  vrs[1] = { values: [CASH_ROW] };
  vrs[9] = { values: [
    ['2026-03-15', '30000', '삼성전자'],
    ['2026-03-20', '20000', 'AAPL'],
    ['2026-04-05', '15000', '카카오'],
  ] };
  const { dividends } = parseSheetData(vrs);
  assert.equal(dividends.length, 2);
  const mar = dividends.find(d => d.month === 3);
  const apr = dividends.find(d => d.month === 4);
  assert.equal(mar.amount, 50000);
  assert.equal(mar.items.length, 2);
  assert.equal(apr.amount, 15000);
});

test('parseDividends: 날짜·금액 없는 행 필터', () => {
  const vrs = makeVR();
  vrs[1] = { values: [CASH_ROW] };
  vrs[9] = { values: [
    ['', '10000', '종목A'],              // 날짜 없음
    ['2026-03-01', '', '종목B'],        // 금액 없음
    ['2026-03-15', '30000', '종목C'],   // 정상
  ] };
  const { dividends } = parseSheetData(vrs);
  assert.equal(dividends.length, 1);
  assert.equal(dividends[0].amount, 30000);
});

// ── parseMonthly ──────────────────────────────────────────

test('parseMonthly: 연도 carry-forward', () => {
  const vrs = makeVR();
  vrs[1] = { values: [CASH_ROW] };
  // 월별잔고(index 8): [연도, 월, 적립, -, -, -, -, 총잔고, kospi, sp500]
  vrs[8] = { values: [
    ['2026', '1', '500000', '', '', '', '', '10000000', '2500', '5000'],
    ['',     '2', '500000', '', '', '', '', '10500000', '2520', '5100'],  // 연도 빈값 → carry-forward
  ] };
  const { monthly } = parseSheetData(vrs);
  assert.equal(monthly.length, 2);
  assert.equal(monthly[0].label, '26.01');
  assert.equal(monthly[1].label, '26.02');  // carry-forward 정상 동작
  assert.equal(monthly[0].value, 10000000);
  assert.equal(monthly[1].kospi, 2520);
});

test('parseMonthly: 총잔고 없는 행 필터', () => {
  const vrs = makeVR();
  vrs[1] = { values: [CASH_ROW] };
  vrs[8] = { values: [
    ['2026', '1', '500000', '', '', '', '', '', '', ''],         // 총잔고 없음
    ['2026', '2', '500000', '', '', '', '', '10500000', '', ''], // 정상
  ] };
  const { monthly } = parseSheetData(vrs);
  assert.equal(monthly.length, 1);
  assert.equal(monthly[0].label, '26.02');
});

// ── parsePreferences ──────────────────────────────────────

test('parsePreferences: observation 없는 행 필터 + 최신순', () => {
  const vrs = makeVR();
  vrs[1] = { values: [CASH_ROW] };
  // 성향관찰(index 18): [날짜, 신호유형, 관찰, 증거, §3대비, 신뢰도, 상태, 갱신시각]
  vrs[18] = { values: [
    ['2026-01-01', '체결행동', '손절을 오래 미룬다', '근거1', '신규', '높음', '확정', ''],
    ['2026-03-01', '명시',     '',                  '',      '',     '',    '관찰', ''],  // 관찰 없음 → 필터
    ['2026-02-01', '체결행동', '500만 한도 초과',    '근거2', '신규', '보통', '관찰', ''],
  ] };
  const { preferences } = parseSheetData(vrs);
  assert.equal(preferences.length, 2);      // 빈 관찰 행 제외
  assert.equal(preferences[0].date, '2026-02-01');   // 최신(2월)이 앞
  assert.equal(preferences[0].status, '관찰');
  assert.equal(preferences[1].status, '확정');
});

// ── parseRiskMonitor ──────────────────────────────────────

test('parseRiskMonitor: 최신순 정렬', () => {
  const vrs = makeVR();
  vrs[1] = { values: [CASH_ROW] };
  vrs[14] = { values: [
    ['2026-01-10', 'B', '삼성전자', '🟡', '요약', '', '', ''],
    ['2026-06-01', 'D', '거시',    '🔴', '요약', '', '', ''],
  ] };
  const { riskMonitor } = parseSheetData(vrs);
  assert.equal(riskMonitor.length, 2);
  assert.equal(riskMonitor[0].date, '2026-06-01');   // 최신이 앞
  assert.equal(riskMonitor[0].type, 'D');
});

test('parseRiskMonitor: 날짜 없는 행 필터', () => {
  const vrs = makeVR();
  vrs[1] = { values: [CASH_ROW] };
  vrs[14] = { values: [
    ['',            'B', '삼성전자', '🟡', '', '', '', ''],  // 날짜 없음
    ['2026-06-01', 'D', '거시',    '🔴', '', '', '', ''],
  ] };
  const { riskMonitor } = parseSheetData(vrs);
  assert.equal(riskMonitor.length, 1);
  assert.equal(riskMonitor[0].date, '2026-06-01');
});
