import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickUnprocessedExecutions, pickUnprocessedDividends, pickAccountlessAppliedExecutions, matchesKnownExecution, findMatchingKnownExecution, duplicateSkipFrontmatter, pickKnownExecutions, OWNER_CONFIRMED_SOURCE } from './update-holdings-from-executions.mjs';

const f = (parsed) => ({ filepath: '/x', content: '', parsed });

test('pickUnprocessedExecutions: legacy(Phase 7 마이그레이션) 제외 — 이미 스냅샷에 반영됨', () => {
  const files = [f({ legacy: true, tradeDate: '2026-01-01' }), f({ tradeDate: '2026-01-02' })];
  const r = pickUnprocessedExecutions(files);
  assert.equal(r.length, 1);
  assert.equal(r[0].parsed.tradeDate, '2026-01-02');
});

test('pickUnprocessedExecutions: holdingsApplied 이미 true인 것 제외 — 재처리 방지', () => {
  const files = [
    f({ holdingsApplied: true, tradeDate: '2026-01-01' }),
    f({ holdingsApplied: 'duplicate-skipped', tradeDate: '2026-01-01' }),
    f({ tradeDate: '2026-01-02' }),
  ];
  const r = pickUnprocessedExecutions(files);
  assert.equal(r.length, 1);
});

test('duplicateSkipFrontmatter: 건너뛴 체결은 적용 완료와 구분하고 매치 파일 경로가 있을 때만 연결', () => {
  const execution = { stockName: '삼성전자' };
  const withMatch = duplicateSkipFrontmatter('위탁', execution, { filepath: '/tmp/2026-09-03-체결.md' });
  assert.equal(withMatch.holdingsApplied, 'duplicate-skipped');
  assert.equal(withMatch.duplicateOf, '2026-09-03-체결');
  assert.equal(duplicateSkipFrontmatter('위탁', execution).duplicateOf, undefined);
});

test('2차 방어 재시도는 appliedDedupKeys가 증명할 때만 다음 실행의 known 체결이다', () => {
  const fill = { tradeDate: '2026-06-19 10:15:04', tradeType: '매수', stockName: '금 99.99K', quantity: 2, price: 205350, account: '위탁' };
  const retry = { ...fill, dedupKey: 'first-key', holdingsApplied: true, filepath: '/tmp/first.md' };
  const crossSource = { ...fill, dedupKey: 'other-key', holdingsApplied: 'duplicate-skipped', filepath: '/tmp/other.md' };
  const linked = { ...fill, dedupKey: 'third-key', holdingsApplied: true, duplicateOf: 'first', filepath: '/tmp/linked.md' };
  const holdings = new Map([['위탁|금 99.99K', { appliedDedupKeys: ['first-key'] }]]);
  const known = pickKnownExecutions([retry, crossSource, linked], holdings);
  // duplicateOf 표시 행(옛 이중 기록, holdingsApplied true)은 대조 기준에 남는다 — 주문번호 단서 보존.
  assert.deepEqual(known, [retry, linked]);
  const laterDifferentKey = { ...fill, dedupKey: 'later-key' };
  assert.equal(findMatchingKnownExecution(laterDifferentKey, known), retry);
  assert.equal(pickKnownExecutions([retry], new Map()).length, 1);
});

test('pickUnprocessedExecutions: tradeDate 오름차순 정렬(가중평균 순서가 중요)', () => {
  const files = [f({ tradeDate: '2026-03-01' }), f({ tradeDate: '2026-01-01' }), f({ tradeDate: '2026-02-01' })];
  const r = pickUnprocessedExecutions(files);
  assert.deepEqual(r.map((x) => x.parsed.tradeDate), ['2026-01-01', '2026-02-01', '2026-03-01']);
});

test('pickUnprocessedDividends: legacy(Phase 7 마이그레이션) 제외 — account:null로 영구 고정된 스냅샷', () => {
  const files = [f({ legacy: true, account: null, date: '2026-01-01' }), f({ account: null, date: '2026-01-02' })];
  const r = pickUnprocessedDividends(files);
  assert.equal(r.length, 1);
  assert.equal(r[0].parsed.date, '2026-01-02');
});

test('pickUnprocessedDividends: account 이미 확정된 것 제외 — 재처리 방지(holdingsApplied 대신 account 유무로 판정)', () => {
  const files = [f({ account: 'ISA', date: '2026-01-01' }), f({ account: null, date: '2026-01-02' })];
  const r = pickUnprocessedDividends(files);
  assert.equal(r.length, 1);
  assert.equal(r[0].parsed.date, '2026-01-02');
});

test('pickUnprocessedDividends: date 오름차순 정렬', () => {
  const files = [f({ account: null, date: '2026-03-01' }), f({ account: null, date: '2026-01-01' }), f({ account: null, date: '2026-02-01' })];
  const r = pickUnprocessedDividends(files);
  assert.deepEqual(r.map((x) => x.parsed.date), ['2026-01-01', '2026-02-01', '2026-03-01']);
});

test('[막아야 함/실사고] pickAccountlessAppliedExecutions: holdingsApplied:true·account:null(계좌 영구기록 시작 전 처리분) 골라냄', () => {
  const files = [
    f({ holdingsApplied: true, account: null, tradeDate: '2026-06-01' }), // 백필 대상(실측 84건 중 60건이 이 상태였음)
    f({ holdingsApplied: true, account: '위탁', tradeDate: '2026-06-02' }), // 이미 채워짐 — 제외
    f({ holdingsApplied: false, account: null, tradeDate: '2026-06-03' }), // 아직 미처리 — pickUnprocessedExecutions 몫, 여기 대상 아님
    f({ holdingsApplied: 'duplicate-skipped', account: null, tradeDate: '2026-06-04' }), // 적용 이력이 아니므로 백필 제외
  ];
  const r = pickAccountlessAppliedExecutions(files);
  assert.equal(r.length, 1);
  assert.equal(r[0].parsed.tradeDate, '2026-06-01');
});

test('pickAccountlessAppliedExecutions: legacy는 제외(account:null이 영구 고정 스냅샷)', () => {
  const files = [f({ legacy: true, holdingsApplied: true, account: null })];
  assert.equal(pickAccountlessAppliedExecutions(files).length, 0);
});

const exec = (overrides = {}) => ({ tradeDate: '2026-06-19 10:15:04', tradeType: '매수', stockName: '금 99.99K', quantity: 2, price: 205350, ...overrides });

test('[막아야 함/실사고] matchesKnownExecution: 날짜(일단위)·구분·종목명·수량 일치하면 중복(2026-08-18 발견 — 알람 시트 잔존 옛 행이 마이그레이션 스냅샷을 재적용해 12개 보유종목 오염시킨 실사고)', () => {
  const legacy = [{ tradeDate: '2026-06-19', tradeType: '매수', stockName: '금 99.99K', quantity: 2, price: 205350 }];
  assert.equal(matchesKnownExecution(exec(), legacy), true);
});

test('[막아야 함/실사고2] matchesKnownExecution: 단가가 달라도 중복(2026-08-18 재발견 — 해외주식은 legacy가 원화환산가·live가 USD원문가라 단가가 절대 같아질 수 없음, 이 조건 때문에 마이크로소프트·알파벳·엔비디아 중복 7건이 탐지를 피해 실제 앱 잔고와 다르게 재적용됐던 실사고)', () => {
  const legacy = [{ tradeDate: '2026-05-12', tradeType: '매수', stockName: '마이크로소프트', quantity: 2, price: 585919 }];
  const liveUsd = { tradeDate: '2026-05-12 13:20:58', tradeType: '매수', stockName: '마이크로소프트', quantity: 2, price: 410.565 };
  assert.equal(matchesKnownExecution(liveUsd, legacy), true);
});

test('matchesKnownExecution: 시각까지 있는 legacy tradeDate라도 날짜(앞 10자)만 비교', () => {
  const legacy = [{ tradeDate: '2026-06-19 00:00:00', tradeType: '매수', stockName: '금 99.99K', quantity: 2, price: 205350 }];
  assert.equal(matchesKnownExecution(exec(), legacy), true);
});

test('matchesKnownExecution: 수량이 다르면 중복 아님(진짜 다른 체결)', () => {
  const legacy = [{ tradeDate: '2026-06-19', tradeType: '매수', stockName: '금 99.99K', quantity: 3, price: 205350 }];
  assert.equal(matchesKnownExecution(exec(), legacy), false);
});

test('matchesKnownExecution: legacy 없으면 false', () => {
  assert.equal(matchesKnownExecution(exec(), []), false);
});

test('NH 누적 대조에서 duplicateOf 카카오 행은 별도 체결 수량으로 세지 않는다', () => {
  const order = { tradeDate: '2026-06-19 00:00:00', tradeType: '매수', stockName: '금 99.99K',
    quantity: 1, orderNo: '123', account: '위탁', broker: 'NH투자증권' };
  const api = { ...order, source: 'NH_API', orderCumulativeQty: 1 };
  const kakao = { ...order, source: 'KAKAO' };
  const marked = { ...kakao, duplicateOf: 'original' };
  assert.equal(findMatchingKnownExecution(kakao, [api], [api, kakao, marked]), api);
});

// 실사고 회귀 테스트(2026-08-19, 오너 지시 "체결도 매핑 가능하면 매핑해봐") — 전량청산돼
// 보유 파일이 없는 종목(삼성바이오로직스·현대차 매도 등)은 이름매칭 대조 대상 자체가
// 없어 영구히 계좌귀속불가였는데, legacy 스냅샷엔 이미 그 계좌가 남아있었다.
test('[막아야 함/실사고3] findMatchingKnownExecution: 매치되면 그 legacy 레코드(account 포함) 자체를 반환', () => {
  const legacy = [{ tradeDate: '2026-07-13', tradeType: '매도', stockName: '삼성바이오로직스', quantity: 1, account: '위탁' }];
  const r = findMatchingKnownExecution({ tradeDate: '2026-07-13 12:27:53', tradeType: '매도', stockName: '삼성바이오로직스', quantity: 1 }, legacy);
  assert.equal(r?.account, '위탁');
});

test('findMatchingKnownExecution: 매치 없으면 null', () => {
  assert.equal(findMatchingKnownExecution(exec(), []), null);
});

test('[중복방지] 양쪽에 주문번호가 있으면 정확히 같은 브로커 주문만 크로스소스 중복으로 본다', () => {
  const apiExecution = exec({ broker: 'NH투자증권', orderNo: '847026' });
  assert.ok(findMatchingKnownExecution(apiExecution, [
    exec({ broker: 'NH투자증권', orderNo: '847026', holdingsApplied: true }),
  ]));
  assert.equal(findMatchingKnownExecution(apiExecution, [
    exec({ broker: 'NH투자증권', orderNo: '847027', holdingsApplied: true }),
  ]), null);
  assert.equal(findMatchingKnownExecution(apiExecution, [
    exec({ broker: '한국투자증권', orderNo: '847026', holdingsApplied: true }),
  ]), null);
  assert.equal(findMatchingKnownExecution({ ...apiExecution, account: '위탁' }, [
    exec({ broker: 'NH투자증권', orderNo: '847026', account: 'ISA', holdingsApplied: true }),
  ]), null);
});

test('findMatchingKnownExecution: 한쪽 주문번호가 없는 구형 기록은 기존 호환 매칭 유지', () => {
  const apiExecution = exec({ broker: 'NH투자증권', orderNo: '847026' });
  assert.ok(findMatchingKnownExecution(apiExecution, [exec({ broker: 'NH투자증권', holdingsApplied: true })]));
});

test('[중복방지] 한쪽 주문번호가 빠져도 알려진 계좌가 다르면 별개 거래로 둔다', () => {
  const apiExecution = exec({ broker: 'NH투자증권', orderNo: '847026', account: '위탁' });
  assert.equal(findMatchingKnownExecution(apiExecution, [
    exec({ broker: 'NH투자증권', account: 'ISA', holdingsApplied: true }),
  ]), null);
});

// 코드리뷰 지적(2026-08-19) — 같은 날·구분·종목명·수량인데 계좌가 다른 legacy 후보가
// 둘 이상이면(이론상 가능) 어느 쪽인지 추정하지 않는다. dedup 판정(레코드 자체 반환)은
// 유지하되 account만 null로 낮춘다.
test('[막아야 함] findMatchingKnownExecution: 후보가 여럿인데 계좌가 갈리면 추정하지 않고 account:null(레코드는 반환 — dedup 판정은 유지)', () => {
  const legacy = [
    { tradeDate: '2026-06-19', tradeType: '매수', stockName: '금 99.99K', quantity: 2, account: 'ISA', filepath: '/tmp/isa.md' },
    { tradeDate: '2026-06-19', tradeType: '매수', stockName: '금 99.99K', quantity: 2, account: '위탁', filepath: '/tmp/consignment.md' },
  ];
  const r = findMatchingKnownExecution(exec(), legacy);
  assert.notEqual(r, null);
  assert.equal(r.account, null);
  assert.equal(r.filepath, undefined);
});

test('findMatchingKnownExecution: 후보가 여럿이어도 계좌가 전부 같으면 그 계좌 그대로', () => {
  const legacy = [
    { tradeDate: '2026-06-19', tradeType: '매수', stockName: '금 99.99K', quantity: 2, account: 'ISA' },
    { tradeDate: '2026-06-19', tradeType: '매수', stockName: '금 99.99K', quantity: 2, account: 'ISA' },
  ];
  const r = findMatchingKnownExecution(exec(), legacy);
  assert.equal(r.account, 'ISA');
});

// [막아야 함/실사고4] 2026-09-03 code-reviewer 지적으로 발견 — 카카오 파싱과
// reconcile-nh-executions.mjs(NH API 직접조회)가 같은 실제 체결을 각자 별도
// 파일로 기록하면(의도된 병행기간), 원래 findMatchingLegacyExecution은 legacy
// (v1 마이그레이션 스냅샷)와만 대조해 이 크로스소스 중복을 못 잡았다 — 실제
// 라이브 Vault 데이터(2026-09-02 메리츠금융지주 매도 30주, 카카오로 이미
// holdingsApplied:true+실현손익 기록됨)로 재현 확인: 이 상태에서 이 잡이 도는
// 매 실행마다 knownExecutions에는 "이미 holdingsApplied된(legacy 아닌) 체결"도
// 포함돼야 한다 — 함수 자체는 이미 날짜(일단위)·구분·종목명·수량만 보므로
// legacy 여부와 무관하게 이 판정을 그대로 재사용할 수 있음을 검증.
test('[막아야 함/실사고4] findMatchingKnownExecution: legacy가 아니라 "이미 holdingsApplied된 다른 소스 체결"과도 매치(크로스소스 이중반영 방지)', () => {
  const alreadyApplied = [{ tradeDate: '2026-09-02 12:37:08', tradeType: '매도', stockName: '메리츠금융지주', quantity: 30, account: '위탁', legacy: undefined, holdingsApplied: true }];
  const nhApiExec = { tradeDate: '2026-09-02 00:00:00', tradeType: '매도', stockName: '메리츠금융지주', quantity: 30 };
  const r = findMatchingKnownExecution(nhApiExec, alreadyApplied);
  assert.notEqual(r, null);
  assert.equal(r.account, '위탁');
});

test('[중복방지] NH API 누적 체결수량이 카카오 개별 부분체결을 포함하면 수량이 달라도 이미 반영된 주문으로 매치', () => {
  const alreadyApplied = [{
    tradeDate: '2026-09-24 00:00:00', tradeType: '매수', stockName: '삼성전자',
    quantity: 5, orderCumulativeQty: 5, source: 'NH_API', broker: 'NH투자증권',
    orderNo: '847026', account: '위탁', holdingsApplied: true,
  }];
  const kakaoPartial = {
    tradeDate: '2026-09-24 09:10:00', tradeType: '매수', stockName: '삼성전자',
    quantity: 2, broker: 'NH투자증권', orderNo: '847026', account: '위탁',
  };
  assert.equal(findMatchingKnownExecution(kakaoPartial, alreadyApplied), alreadyApplied[0]);
});

test('NH API 누적수량만으로 주문번호 없는 카카오 이벤트를 덮어 매칭하지 않음', () => {
  const api = [{
    tradeDate: '2026-09-24 00:00:00', tradeType: '매수', stockName: '삼성전자',
    quantity: 5, orderCumulativeQty: 5, source: 'NH_API', broker: 'NH투자증권',
    orderNo: '847026', account: '위탁', holdingsApplied: true,
  }];
  const noOrderId = {
    tradeDate: '2026-09-24 09:10:00', tradeType: '매수', stockName: '삼성전자',
    quantity: 2, broker: 'NH투자증권', orderNo: '',
  };
  assert.equal(findMatchingKnownExecution(noOrderId, api), null);
});

test('[막아야 함] API가 Kakao와 같은 주문의 잔여 2주를 기록한 경우, Kakao 2주와 수량이 같아도 API 이벤트를 중복 처리하지 않음', () => {
  const kakao = {
    tradeDate: '2026-09-24 09:10:00', tradeType: '매수', stockCode: '005930', stockName: '삼성전자',
    quantity: 2, broker: 'NH투자증권', orderNo: '847026', account: null, holdingsApplied: true,
  };
  const apiRemainder = {
    tradeDate: '2026-09-24 00:00:00', tradeType: '매수', stockCode: '005930', stockName: '삼성전자',
    quantity: 2, orderCumulativeQty: 5, source: 'NH_API', broker: 'NH투자증권',
    orderNo: '847026', account: '위탁',
  };
  assert.equal(findMatchingKnownExecution(apiRemainder, [kakao], [kakao, apiRemainder]), null);
});

test('[막아야 함] 여러 카카오 부분체결 합계가 API 누적량을 넘으면 각각을 중복 처리하지 않고 충돌로 보류', () => {
  const api = {
    tradeDate: '2026-09-24 00:00:00', tradeType: '매수', stockCode: '005930', stockName: '삼성전자',
    quantity: 2, orderCumulativeQty: 5, source: 'NH_API', broker: 'NH투자증권',
    orderNo: '847026', account: '위탁', holdingsApplied: true,
  };
  const kakaoA = { tradeDate: '2026-09-24 09:10:00', tradeType: '매수', stockCode: '005930', stockName: '삼성전자', quantity: 4, broker: 'NH투자증권', orderNo: '847026', account: '위탁' };
  const kakaoB = { ...kakaoA, tradeDate: '2026-09-24 09:11:00', account: '위탁' };
  const result = findMatchingKnownExecution(kakaoA, [api], [api, kakaoA, kakaoB]);
  assert.equal(result.crossSourceConflict, true);
  assert.match(result.reason, /카카오 누적 8주.*NH API 누적 5주/);
  assert.equal(matchesKnownExecution(kakaoA, [api], [api, kakaoA, kakaoB]), false);
});

test('같은 주문은 종목코드 일치 시 API·Kakao 종목명 표기가 달라도 대조하고, 코드가 다르면 제외', () => {
  const api = {
    tradeDate: '2026-09-24 00:00:00', tradeType: '매수', stockCode: '005930', stockName: '삼성전자보통주',
    quantity: 5, orderCumulativeQty: 5, source: 'NH_API', broker: 'NH투자증권',
    orderNo: '847026', account: '위탁', holdingsApplied: true,
  };
  const kakao = { tradeDate: '2026-09-24 09:10:00', tradeType: '매수', stockCode: '005930', stockName: '삼성전자', quantity: 2, broker: 'NH투자증권', orderNo: '847026', account: '위탁' };
  assert.equal(findMatchingKnownExecution(kakao, [api], [api, kakao]), api);
  assert.equal(findMatchingKnownExecution({ ...kakao, stockCode: '000660' }, [api], [api, kakao]), null);
});

test('[막아야 함] 계좌 미상 Kakao 체결은 단일 NH API 주문번호가 있어도 자동 중복판정하지 않음', () => {
  const api = {
    tradeDate: '2026-09-24 00:00:00', tradeType: '매수', stockCode: '005930', stockName: '삼성전자',
    quantity: 5, orderCumulativeQty: 5, source: 'NH_API', broker: 'NH투자증권',
    orderNo: '847026', account: '위탁', holdingsApplied: true,
  };
  const kakao = {
    tradeDate: '2026-09-24 09:10:00', tradeType: '매수', stockCode: '005930', stockName: '삼성전자',
    quantity: 2, broker: 'NH투자증권', orderNo: '847026', account: null,
  };
  const result = findMatchingKnownExecution(kakao, [api], [api, kakao]);
  assert.equal(result.crossSourceConflict, true);
  assert.match(result.reason, /계좌가 없어/);
});

test('[막아야 함/실사고5] 같은 출처의 서로 다른 sourceEventId는 수량이 같아도 중복이 아니다(2026-10-27 연금저축 14건 분할체결 중 8건 12주 오판정)', () => {
  // 실제 2026-10-27 13:40 받은 12건의 수량 순서. main() 루프처럼 반영한 체결을 곧바로 known에 넣는다.
  const quantities = [2, 1, 2, 1, 3, 3, 1, 9, 2, 1, 1, 1];
  const known = [];
  let applied = 0;
  quantities.forEach((quantity, index) => {
    const exec = {
      tradeDate: `2026-10-27 13:40:${String(27 + index).padStart(2, '0')}`, tradeType: '매도',
      stockName: 'TIGER 미국배당다우존스', quantity, broker: '삼성증권', orderNo: '',
      source: 'KAKAO', sourceEventId: `kakao-${index}`, account: '연금저축',
    };
    assert.equal(findMatchingKnownExecution(exec, known), null, `${index + 1}번째 ${quantity}주가 앞 기록의 중복으로 잡힘`);
    known.push(exec);
    applied += quantity;
  });
  assert.equal(applied, 27);
});

test('같은 출처라도 sourceEventId가 같거나 한쪽에 없으면 기존 수량 대조로 중복을 잡는다', () => {
  const base = { tradeDate: '2026-10-27 13:40:27', tradeType: '매도', stockName: 'TIGER 미국배당다우존스', quantity: 2, broker: '삼성증권', source: 'KAKAO' };
  assert.ok(matchesKnownExecution({ ...base, sourceEventId: 'a' }, [{ ...base, sourceEventId: 'a' }]));
  assert.ok(matchesKnownExecution({ ...base, sourceEventId: 'a' }, [{ ...base }]));
  // 출처가 다르면(legacy·NH API 등 다른 경로) sourceEventId가 달라도 크로스소스 중복 대조는 그대로다.
  assert.ok(matchesKnownExecution({ ...base, sourceEventId: 'a' }, [{ ...base, source: 'NH_API', sourceEventId: 'gb-1' }]));
  assert.ok(matchesKnownExecution({ ...base, sourceEventId: 'a' }, [{ ...base, source: undefined, legacy: true }]));
});

test('[막아야 함/실사고5] 같은 초·같은 단가·같은 수량이라도 sourceEventId가 다르면 별개 체결이다(10-27 13:40:30 3주 두 건 실데이터)', () => {
  const pair = { tradeDate: '2026-10-27 13:40:30', tradeType: '매도', stockName: 'TIGER 미국배당다우존스', quantity: 3, price: 14825, broker: '삼성증권', orderNo: '', source: 'KAKAO', account: '연금저축' };
  assert.equal(findMatchingKnownExecution({ ...pair, sourceEventId: 'aeed8eaf012fa0410a897f8c25d73f29' }, [{ ...pair, sourceEventId: 'a71a6344005747b42837cb34e0d7c64c' }]), null);
});

test('NH 해외 일별거래(주문번호 없음)도 trd_sno가 다르면 같은 날 같은 수량이어도 별개 거래다', () => {
  const row = { tradeDate: '2026-10-27 00:00:00', tradeType: '매수', stockCode: 'GOOGL', stockName: '알파벳 Class A', quantity: 2, broker: 'NH투자증권 해외', orderNo: '', source: 'NH_API', account: '위탁' };
  assert.equal(findMatchingKnownExecution({ ...row, sourceEventId: 'gb-20261027-2' }, [{ ...row, sourceEventId: 'gb-20261027-1' }]), null);
  assert.ok(matchesKnownExecution({ ...row, sourceEventId: 'gb-20261027-1' }, [{ ...row, sourceEventId: 'gb-20261027-1' }]));
});

test('오너 확인 기록(알림 누락분)은 같은 날 같은 수량의 카카오 체결과 서로 중복으로 보지 않는다(양방향)', () => {
  const kakao = { tradeDate: '2026-10-27 13:40:27', tradeType: '매도', stockName: 'TIGER 미국배당다우존스', quantity: 2, broker: '삼성증권', orderNo: '', source: 'KAKAO', sourceEventId: 'k1', account: '연금저축' };
  const owner = { ...kakao, tradeDate: '2026-10-27 00:00:00', source: OWNER_CONFIRMED_SOURCE, sourceEventId: 'owner-20261027-6' };
  assert.equal(findMatchingKnownExecution(owner, [kakao]), null);
  // 반대 방향도 막는다: 시각 미상이라 먼저 반영된 오너 행에 같은 수량의 실제 카카오 체결이 걸리면 안 된다.
  assert.equal(findMatchingKnownExecution({ ...kakao, sourceEventId: 'k2' }, [owner]), null);
});
