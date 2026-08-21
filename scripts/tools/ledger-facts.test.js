import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, assembleCash, assembleTrades, assembleJobs, renderLedgerFacts } from './ledger-facts.mjs';

// ledger-facts.mjs — 운영실 Hermes 대화형 보고용 Node 결정론 사실 조립기.
// Hermes는 "쓰기 단일 창구"라 실제 Vault 쓰기는 헤드리스 잡(parse-notifications-to-vault
// 등)이 담당한다. 이 파일은 보고(읽기) 전용 — anchorBase 갱신 로직은 여기서 재현하지 않고,
// State/Holdings에 이미 확정된 현재 값을 그대로 읽는다(쓰기 경로와 읽기 경로 분리).
// 2026-08-20 Vault 네이티브 전환(구글시트 대체) — 입력이 시트 행 배열에서 Vault
// frontmatter 객체 배열로 바뀌었다.

test('parseArgs — 기본은 전 섹션, --section/--name/--json 플래그', () => {
  assert.deepEqual(parseArgs([]), { section: 'all', name: null, json: false });
  assert.deepEqual(parseArgs(['--section', 'cash']), { section: 'cash', name: null, json: false });
  assert.deepEqual(parseArgs(['--section', 'trades', '--name', '알파벳']), { section: 'trades', name: '알파벳', json: false });
  assert.deepEqual(parseArgs(['--json']), { section: 'all', name: null, json: true });
});

test('parseArgs — 잘못된 section 거부', () => {
  assert.throws(() => parseArgs(['--section', 'x']), /section/i);
});

function cashHolding(overrides = {}) {
  return { account: '위탁', name: '예수금', isCashLike: true, evalAmount: 5000000, anchorTs: '2026-07-15 09:00', anchorSource: '자동', ...overrides };
}

test('assembleCash — 계좌별 기준액·기준일·소스 서술 (State/Holdings 예수금 항목)', () => {
  const holdings = [
    cashHolding(),
    cashHolding({ account: 'ISA', evalAmount: 1200000, anchorSource: '수동' }),
    // isCashLike이지만 "예수금"이 아닌 다른 현금성 상품은 예수금 보고 범위 밖
    { account: '위탁', name: '외화 RP', isCashLike: true, evalAmount: 999999 },
  ];
  const { text, byAcct } = assembleCash(holdings);
  assert.match(text, /위탁/);
  assert.match(text, /5,000,000/);
  assert.match(text, /ISA/);
  assert.equal(byAcct.위탁.base, 5000000);
  assert.equal(byAcct.위탁.source, '자동');
  assert.doesNotMatch(text, /999,999/);
});

test('assembleCash — 빈 목록/예수금 항목 없음은 데이터 부족', () => {
  assert.match(assembleCash([]).text, /데이터 부족/);
  assert.match(assembleCash([{ account: '위탁', name: '외화 RP', isCashLike: true, evalAmount: 1 }]).text, /데이터 부족/);
});

function execution(overrides = {}) {
  return { tradeDate: '2026-07-17', tradeType: '매수', account: '위탁', stockName: '알파벳', quantity: 2, price: 342.5, currency: 'USD', ...overrides };
}

test('assembleTrades — name 지정 시 필터, 없으면 최근 N건', () => {
  const executions = [
    execution(),
    execution({ tradeDate: '2026-07-10', tradeType: '매도', account: 'ISA', stockName: 'TIME배당', quantity: 5, price: 33350, currency: 'KRW' }),
  ];
  const filtered = assembleTrades(executions, { name: '알파벳' });
  assert.equal(filtered.rows.length, 1);
  assert.match(filtered.text, /알파벳/);
  assert.doesNotMatch(filtered.text, /TIME배당/);

  const all = assembleTrades(executions, {});
  assert.equal(all.rows.length, 2);
});

test('assembleTrades — USD 체결은 $ 단위로 표시(원화로 왜곡 안 함)', () => {
  const { text } = assembleTrades([execution()], {});
  assert.match(text, /\$342\.5/);
  assert.doesNotMatch(text, /342\.5원/);
});

test('assembleTrades — "최근"은 파일 나열 순서가 아니라 날짜 내림차순', () => {
  // Vault 디렉토리 나열(readdirSync)은 파일명 알파벳순이지 시간순 보장이 아니다(옛
  // 시트 append 순서 문제와 같은 함정) — 여기서도 명시 정렬해야 "최근 N건"이 거짓이 안 됨.
  const executions = [
    execution({ tradeDate: '2026-07-01', stockName: '오래된거래' }),
    execution({ tradeDate: '2026-07-17', stockName: '최신거래' }),
  ];
  const { rows: out } = assembleTrades(executions, { limit: 1 });
  assert.equal(out.length, 1);
  assert.equal(out[0].stockName, '최신거래', '날짜 기준 진짜 최근이 나와야 함');
});

test('assembleTrades — 정확일치 필터도 날짜 내림차순 유지', () => {
  const executions = [
    execution({ tradeDate: '2026-07-01', tradeType: '매수' }),
    execution({ tradeDate: '2026-07-17', tradeType: '매도' }),
  ];
  const { rows: out } = assembleTrades(executions, { name: '알파벳' });
  assert.equal(out[0].tradeDate, '2026-07-17');
});

test('assembleTrades — 선행단어 매칭("알파벳"→"알파벳 Class A", stock-facts findHolding과 동일 원칙)', () => {
  const executions = [execution({ stockName: '알파벳 Class A' })];
  const { rows: out } = assembleTrades(executions, { name: '알파벳' });
  assert.equal(out.length, 1);
});

test('assembleTrades — 과매칭 방지: "삼성"은 "삼성전자"를 매칭하지 않는다', () => {
  const executions = [execution({ stockName: '삼성전자' })];
  assert.deepEqual(assembleTrades(executions, { name: '삼성' }).rows, []);
});

test('assembleTrades — 빈 목록/매칭 없음은 정직하게 명시', () => {
  assert.match(assembleTrades([], {}).text, /없음|데이터 부족/);
  assert.match(assembleTrades([execution()], { name: '테슬라' }).text, /없음/);
});

function jobRecord(overrides = {}) {
  return { job: 'drain', lastRun: '2026-07-18 06:00', status: 'OK', detail: '', failStreak: 0, ...overrides };
}

test('assembleJobs — FAIL 잡을 명확히 플래그', () => {
  const jobs = [
    jobRecord(),
    jobRecord({ job: 'risk-b', lastRun: '2026-07-18 07:00', status: 'FAIL', detail: '401 unauthorized', failStreak: 2 }),
  ];
  const { text, failing } = assembleJobs(jobs);
  assert.equal(failing.length, 1);
  assert.equal(failing[0].job, 'risk-b');
  assert.match(text, /FAIL/);
  assert.match(text, /401 unauthorized/);
});

test('assembleJobs — 전부 OK면 failing 빈 배열', () => {
  const { failing } = assembleJobs([jobRecord()]);
  assert.deepEqual(failing, []);
});

test('assembleJobs — detail이 과도하게 길면 잘라서 가독성·토큰 보호(실증: 라이브 잡 로그가 수백자)', () => {
  const longDetail = '━'.repeat(300);
  const { text } = assembleJobs([jobRecord({ detail: longDetail })]);
  const line = text.split('\n').find((l) => l.includes('drain'));
  assert.ok(line.length < 200, `한 줄이 너무 김: ${line.length}자`);
  assert.match(line, /…/);
});

test('renderLedgerFacts — FAIL 잡의 잘리지 않은 원문을 별도 블록으로 노출(clamp가 사유를 삼키지 않게)', () => {
  const longDetail = 'A'.repeat(200) + ' 실패종목: 마이크로소프트';
  const jobs = assembleJobs([jobRecord({ job: 'risk-b', status: 'FAIL', detail: longDetail, failStreak: 2 })]);
  const out = renderLedgerFacts({ jobs }, { json: false });
  assert.match(out, /실패 상세/);
  assert.match(out, /마이크로소프트/);
});

test('renderLedgerFacts — 사람용은 재조회 금지 가드 포함, --json은 구조 보존', () => {
  const facts = {
    cash: assembleCash([cashHolding()]),
    trades: assembleTrades([], {}),
    jobs: assembleJobs([jobRecord()]),
  };
  const human = renderLedgerFacts(facts, { json: false });
  assert.match(human, /재조회|Node/);
  assert.match(human, /5,000,000/);

  const json = JSON.parse(renderLedgerFacts(facts, { json: true }));
  assert.ok(json.cash && json.trades && json.jobs);
});
