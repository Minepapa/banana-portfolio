import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, assembleCash, assembleTrades, assembleJobs, renderLedgerFacts } from './ledger-facts.mjs';

// ledger-facts.mjs — 운영실 Hermes 대화형 보고용 Node 결정론 사실 조립기.
// Hermes는 "쓰기 단일 창구"라 실제 시트 쓰기는 헤드리스 잡(record-heartbeat 등)이 담당한다.
// 이 파일은 보고(읽기) 전용 — resolveCashBase 같은 앵커 갱신 로직은 여기서 재현하지 않고,
// 예수금기준 시트에 이미 확정된 현재 값을 그대로 읽는다(쓰기 경로와 읽기 경로 분리).

test('parseArgs — 기본은 전 섹션, --section/--name/--json 플래그', () => {
  assert.deepEqual(parseArgs([]), { section: 'all', name: null, json: false });
  assert.deepEqual(parseArgs(['--section', 'cash']), { section: 'cash', name: null, json: false });
  assert.deepEqual(parseArgs(['--section', 'trades', '--name', '알파벳']), { section: 'trades', name: '알파벳', json: false });
  assert.deepEqual(parseArgs(['--json']), { section: 'all', name: null, json: true });
});

test('parseArgs — 잘못된 section 거부', () => {
  assert.throws(() => parseArgs(['--section', 'x']), /section/i);
});

// 예수금기준!A2:E: 계좌0 기준액1 기준일2 소스3 갱신시각4
test('assembleCash — 계좌별 기준액·기준일·소스 서술', () => {
  const rows = [
    ['위탁', '5000000', '2026-07-15', '자동', '2026-07-15 09:00'],
    ['ISA', '1200000', '2026-07-10', '수동', '2026-07-10 08:00'],
  ];
  const { text, byAcct } = assembleCash(rows);
  assert.match(text, /위탁/);
  assert.match(text, /5,000,000/);
  assert.match(text, /ISA/);
  assert.equal(byAcct.위탁.base, 5000000);
  assert.equal(byAcct.위탁.source, '자동');
});

test('assembleCash — 빈 행은 데이터 부족', () => {
  const { text } = assembleCash([]);
  assert.match(text, /데이터 부족/);
});

// 체결내역!A2:M: 날짜0 구분1 계좌2 코드3 자산군4 종목명5 체결가6 수량7 금액8 ...
test('assembleTrades — name 지정 시 필터, 없으면 최근 N건', () => {
  const rows = [
    ['2026-07-17', '매수', '위탁', '', '해외주식', '알파벳', '342.5', '2', '685000'],
    ['2026-07-10', '매도', 'ISA', '', '배당주', 'TIME배당', '33350', '5', '166750'],
  ];
  const filtered = assembleTrades(rows, { name: '알파벳' });
  assert.equal(filtered.rows.length, 1);
  assert.match(filtered.text, /알파벳/);
  assert.doesNotMatch(filtered.text, /TIME배당/);

  const all = assembleTrades(rows, {});
  assert.equal(all.rows.length, 2);
});

test('assembleTrades — "최근"은 시트 순서가 아니라 날짜 내림차순(리뷰 지적: 시트는 시간순 append 아님)', () => {
  // parse-notifications.mjs가 같은 실행 내 금현물을 시각 무관하게 나중에 push하는 등 시트 순서는
  // 시간순을 보장하지 않는다(ExecutionsTab.jsx가 날짜로 재정렬하는 것과 동일 이유). 여기서도 정렬해야
  // "최근 N건"이라는 주장이 거짓이 되지 않는다.
  const rows = [
    ['2026-07-01', '매수', '위탁', '', '', '오래된거래', '1', '1', '1'],  // 시트상 먼저 왔지만 더 과거
    ['2026-07-17', '매수', '위탁', '', '', '최신거래', '1', '1', '1'],    // 시트상 나중에 왔고 더 최신
  ];
  const { rows: out } = assembleTrades(rows, { limit: 1 });
  assert.equal(out.length, 1);
  assert.equal(out[0][5], '최신거래', '날짜 기준 진짜 최근이 나와야 함');
});

test('assembleTrades — 정확일치 필터도 날짜 내림차순 유지', () => {
  const rows = [
    ['2026-07-01', '매수', '위탁', '', '', '알파벳', '1', '1', '1'],
    ['2026-07-17', '매도', '위탁', '', '', '알파벳', '1', '1', '1'],
  ];
  const { rows: out } = assembleTrades(rows, { name: '알파벳' });
  assert.equal(out[0][0], '2026-07-17');
});

test('assembleTrades — 선행단어 매칭("알파벳"→"알파벳 Class A", stock-facts findHolding과 동일 원칙)', () => {
  // 라이브 검증 중 발견: 실제 시트는 "알파벳 Class A"인데 Frank는 "알파벳"으로 부른다.
  // 정확일치만 지원하면 실재하는 체결을 "없음"으로 오보 — Phase 1c에서 고친 것과 같은 버그 클래스.
  const rows = [['2026-07-17', '매수', '위탁', '', '해외주식', '알파벳 Class A', '342.5', '2', '685000']];
  const { rows: out } = assembleTrades(rows, { name: '알파벳' });
  assert.equal(out.length, 1);
});

test('assembleTrades — 과매칭 방지: "삼성"은 "삼성전자"를 매칭하지 않는다', () => {
  const rows = [['2026-07-17', '매수', '위탁', '', '', '삼성전자', '1', '1', '1']];
  assert.deepEqual(assembleTrades(rows, { name: '삼성' }).rows, []);
});

test('assembleTrades — 빈 행/매칭 없음은 정직하게 명시', () => {
  assert.match(assembleTrades([], {}).text, /없음|데이터 부족/);
  assert.match(assembleTrades([['2026-07-17', '매수', '위탁', '', '', '알파벳', '1', '1', '1']], { name: '테슬라' }).text, /없음/);
});

// 잡상태!A2:F: job0 lastRun1 status2 detail3 durationSec4 failStreak5
test('assembleJobs — FAIL 잡을 명확히 플래그', () => {
  const rows = [
    ['drain', '2026-07-18 06:00', 'OK', '', '12', '0'],
    ['risk-b', '2026-07-18 07:00', 'FAIL', '401 unauthorized', '3', '2'],
  ];
  const { text, failing } = assembleJobs(rows);
  assert.equal(failing.length, 1);
  assert.equal(failing[0].job, 'risk-b');
  assert.match(text, /FAIL/);
  assert.match(text, /401 unauthorized/);
});

test('assembleJobs — 전부 OK면 failing 빈 배열', () => {
  const { failing } = assembleJobs([['drain', '', 'OK', '', '', '0']]);
  assert.deepEqual(failing, []);
});

test('assembleJobs — detail이 과도하게 길면 잘라서 가독성·토큰 보호(실증: 라이브 잡 로그가 수백자)', () => {
  const longDetail = '━'.repeat(300);
  const { text } = assembleJobs([['drain', '2026-07-18', 'OK', longDetail, '5', '0']]);
  const line = text.split('\n').find((l) => l.includes('drain'));
  assert.ok(line.length < 200, `한 줄이 너무 김: ${line.length}자`);
  assert.match(line, /…/);
});

test('renderLedgerFacts — FAIL 잡의 잘리지 않은 원문을 별도 블록으로 노출(clamp가 사유를 삼키지 않게)', () => {
  const longDetail = 'A'.repeat(200) + ' 실패종목: 마이크로소프트';
  const jobs = assembleJobs([['risk-b', '2026-07-18', 'FAIL', longDetail, '3', '2']]);
  const out = renderLedgerFacts({ jobs }, { json: false });
  assert.match(out, /실패 상세/);
  assert.match(out, /마이크로소프트/);   // clamp 때문에 요약줄에선 잘렸어도 상세블록엔 온전히 있어야
});

test('renderLedgerFacts — 사람용은 재조회 금지 가드 포함, --json은 구조 보존', () => {
  const facts = {
    cash: assembleCash([['위탁', '5000000', '2026-07-15', '자동', '']]),
    trades: assembleTrades([], {}),
    jobs: assembleJobs([['drain', '', 'OK', '', '', '0']]),
  };
  const human = renderLedgerFacts(facts, { json: false });
  assert.match(human, /재조회|Node/);
  assert.match(human, /5,000,000/);

  const json = JSON.parse(renderLedgerFacts(facts, { json: true }));
  assert.ok(json.cash && json.trades && json.jobs);
});
