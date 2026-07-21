import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHoldingRows, latestConclusions, convictionMap, latestRiskByType,
  buildRebalanceCandidates, buildCrashBuyCandidates, buildSellFromThesis, buildBuyFromEval,
  buildHoldingsFacts, resolveRotationSell, applyThesisGuard, detectThesisReleases, checkConstraints,
  makeMatchKey, RULE500_WON, mk,
} from './order-candidates.mjs';

// ── 픽스처 헬퍼 ──────────────────────────────────────────────────────────────
// 종목투자노트 행: idx1=종목명, idx0=날짜, idx4=결론, idx14=상태
const nrow = (date, name, concl, status = '') => {
  const r = []; r[0] = date; r[1] = name; r[4] = concl; r[14] = status; return r;
};
// 포지션저널 행: idx0=종목명, idx4=유형, idx10=상태
const jrow = (name, kind, status = '보유') => {
  const r = []; r[0] = name; r[4] = kind; r[10] = status; return r;
};
// 리스크모니터 행: idx0=날짜, idx1=유형, idx2=대상, idx3=신호, idx4=요약
const rrow = (date, type, target, signal, summary = '') => [date, type, target, signal, summary];
// 차단해제이력 행(risk-monitor.mjs가 전환 감지 시 기록): idx0=감지일시, idx1=종목명, idx2=이전신호일, idx3=신규신호일, idx4=신규신호
const relrow = (detectedAt, name, from, to, newSignal) => [detectedAt, name, from, to, newSignal];
// 체결내역 행: idx0=날짜, idx1=구분, idx5=종목명
const trow = (date, side, name) => { const r = []; r[0] = date; r[1] = side; r[5] = name; return r; };

test('parseHoldingRows: 병합 자산군 유지·현금성 제외·단가는 평가금/수량(KRW)', () => {
  const rows = [
    ['현금성', '예수금', '', '', '1000000', '', '', '1000000'],
    ['국내주식', '삼성전자', '', '40', '', '', '', '11020000'],
    ['', 'SK하이닉스', '', '5', '', '', '', '10770000'],    // 자산군 병합(빈칸) → 국내주식 유지
    ['달러', '외화 RP', '', '1869', '', '', '', '2808504'],  // 현금성 제외
  ];
  const h = parseHoldingRows('위탁', rows);
  assert.equal(h.length, 2);
  assert.equal(h[0].name, '삼성전자');
  assert.equal(h[0].unitKrw, 275500);
  assert.equal(h[1].assetType, '국내주식');   // 병합 유지
});

test('latestConclusions: 종목별 최신 카드·이모지 판별·매도 카드 표시', () => {
  const m = latestConclusions([
    nrow('2026-06-01', '삼성전자', '🟡 매수관망'),
    nrow('2026-07-01', '삼성전자', '🟢 유효'),
    nrow('2026-07-05', '현대차', '🔴 부적합', '매도'),
  ]);
  assert.equal(m.get('삼성전자').emoji, '🟢');
  assert.equal(m.get('삼성전자').date, '2026-07-01');
  assert.equal(m.get('현대차').isSell, true);
  assert.equal(m.get('현대차').emoji, '🔴');
});

test('convictionMap: 청산 제외·미기재는 배분', () => {
  const m = convictionMap([
    jrow('SK하이닉스', '확신'),
    jrow('현대차', ''),
    jrow('옛종목', '확신', '청산'),
  ]);
  assert.equal(m.get('SK하이닉스'), '확신');
  assert.equal(m.get('현대차'), '배분');
  assert.equal(m.has('옛종목'), false);
});

test('buildRebalanceCandidates: 초과 자산군 매도 — 확신 제외·평가 나쁜 순 선정·수량=갭/단가', () => {
  const holdings = [
    { acct: '위탁', name: 'SK하이닉스', assetType: '국내주식', qty: 5, evalWon: 10770000, unitKrw: 2154000 },
    { acct: '위탁', name: '현대차', assetType: '국내주식', qty: 8, evalWon: 3856000, unitKrw: 482000 },
    { acct: '위탁', name: '삼성전자', assetType: '국내주식', qty: 40, evalWon: 11020000, unitKrw: 275500 },
  ];
  const conviction = new Map([['SK하이닉스', '확신'], ['현대차', '배분'], ['삼성전자', '배분']]);
  const conclusions = new Map([['현대차', { emoji: '🟡', date: '2026-07-05' }]]);   // 삼성전자 무평가
  const gaps = [{ acct: '위탁', assetType: '국내주식', targetPct: 30, currentPct: 36, rebalAmt: -1500000 }];
  const out = buildRebalanceCandidates({ gaps, holdings, conviction, conclusions });
  assert.equal(out.length, 1);
  assert.equal(out[0].side, '매도');
  assert.equal(out[0].name, '현대차');            // 확신(SK하이닉스) 제외, 🟡 > 무평가 우선
  assert.equal(out[0].qty, 3);                    // floor(1,500,000 / 482,000)
  assert.equal(out[0].amount, 3 * 482000);
});

test('buildRebalanceCandidates: 부족 자산군 매수 — 기존 최대 보유에 적립', () => {
  const holdings = [
    { acct: '위탁', name: 'TIGER 리츠', assetType: '리츠', qty: 350, evalWon: 3333750, unitKrw: 9525 },
  ];
  const gaps = [{ acct: '위탁', assetType: '리츠', targetPct: 5, currentPct: -1, rebalAmt: 2859512 }];
  const out = buildRebalanceCandidates({ gaps, holdings, conviction: new Map(), conclusions: new Map() });
  assert.equal(out.length, 1);
  assert.equal(out[0].side, '매수');
  assert.equal(out[0].qty, Math.floor(2859512 / 9525));
});

test('buildRebalanceCandidates: 갭 5%p 미만·풀 전체 확신이면 후보 없음', () => {
  const holdings = [{ acct: '위탁', name: 'SK하이닉스', assetType: '국내주식', qty: 5, evalWon: 1e7, unitKrw: 2e6 }];
  const conviction = new Map([['SK하이닉스', '확신']]);
  assert.equal(buildRebalanceCandidates({
    gaps: [{ acct: '위탁', assetType: '국내주식', targetPct: 30, currentPct: 33, rebalAmt: -1e6 }],
    holdings, conviction, conclusions: new Map(),
  }).length, 0);   // 3%p < 트리거
  assert.equal(buildRebalanceCandidates({
    gaps: [{ acct: '위탁', assetType: '국내주식', targetPct: 30, currentPct: 37, rebalAmt: -1e6 }],
    holdings, conviction, conclusions: new Map(),
  }).length, 0);   // 유일 후보가 확신 → 매도 안 함
});

test('buildCrashBuyCandidates: O🔴만·500만/예수금 이내 수량·보유 계좌로', () => {
  const oSignals = latestRiskByType([
    rrow('2026-07-09', 'O', '현대차', '🔴', '급락 매수 기회 — 5일 -12%'),
    rrow('2026-07-09', 'O', '삼성전자', '🟢', '트리거 없음'),
  ], 'O');
  const holdings = [{ acct: '위탁', name: '현대차', assetType: '국내주식', qty: 8, evalWon: 3856000, unitKrw: 482000 }];
  const out = buildCrashBuyCandidates({ oSignals, holdings, cash: { 위탁: 1200000 } });
  assert.equal(out.length, 1);                     // 🟢 제외
  assert.equal(out[0].qty, 2);                     // floor(min(5M, 1.2M)/482,000)
  assert.equal(out[0].acct, '위탁');
});

test('buildSellFromThesis: 매도평가 🔴 있으면 전량 매도, 없으면 매도평가 의뢰', () => {
  const bSignals = latestRiskByType([
    rrow('2026-07-06', 'B', '현대차', '🔴', '수익성 훼손'),
    rrow('2026-07-06', 'B', '테슬라', '🔴', '전제 붕괴'),
  ], 'B');
  const holdings = [
    { acct: '위탁', name: '현대차', assetType: '국내주식', qty: 8, evalWon: 3856000, unitKrw: 482000 },
    { acct: '위탁', name: '테슬라', assetType: '해외주식', qty: 23, evalWon: 13620357, unitKrw: 592189 },
  ];
  const conclusions = new Map([['현대차', { date: '2026-07-08', emoji: '🔴', isSell: true }]]);
  const { candidates, evalRequests } = buildSellFromThesis({
    bSignals, holdings, conviction: new Map(), conclusions,
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].name, '현대차');
  assert.equal(candidates[0].qty, 8);              // 전량
  assert.equal(evalRequests.length, 1);
  assert.equal(evalRequests[0].name, '테슬라');    // 카드 없음 → 의뢰
});

test('buildBuyFromEval: 🟢 후 미매수만·미보유는 price null(잡이 해결)', () => {
  const conclusions = new Map([
    ['삼성전자', { date: '2026-07-01', emoji: '🟢', isSell: false }],   // 이후 매수함 → 제외
    ['가온전선', { date: '2026-07-01', emoji: '🟢', isSell: false }],   // 미보유·미매수 → 후보(price null)
    ['현대차', { date: '2026-07-05', emoji: '🟡', isSell: false }],     // 🟢 아님 → 제외
  ]);
  const execRows = [trow('2026-07-03 10:00', '매수', '삼성전자')];
  const out = buildBuyFromEval({ conclusions, execRows, holdings: [], cash: { 위탁: 3000000 } });
  assert.equal(out.length, 1);
  assert.equal(out[0].name, '가온전선');
  assert.equal(out[0].price, null);
  assert.equal(out[0].qty, null);
});

test('checkConstraints: 매수 예수금·500만(확신 예외)·매도 확신보호', () => {
  const conviction = new Map([['SK하이닉스', '확신']]);
  // 예수금 부족 → ✗
  const c1 = checkConstraints({ side: '매수', acct: '위탁', name: '삼성전자', amount: 2000000 },
    { cash: { 위탁: 1000000 }, conviction });
  assert.equal(c1.find(x => x.k === '예수금').ok, false);
  // 500만 초과 + 확신 → ok(예외 라벨)
  const c2 = checkConstraints({ side: '매수', acct: '위탁', name: 'SK하이닉스', amount: 6000000 },
    { cash: { 위탁: 10000000 }, conviction });
  const rule = c2.find(x => x.k === '500만원칙');
  assert.equal(rule.ok, true);
  assert.match(rule.d, /확신/);
  // 확신 종목 매도 → ✗ 플래그
  const c3 = checkConstraints({ side: '매도', acct: '위탁', name: 'SK하이닉스' }, { cash: {}, conviction });
  assert.equal(c3.find(x => x.k === '확신보호').ok, false);
});

test('날짜 시리얼 방어: 평가일이 시리얼이어도 이후 매수를 정확히 감지 (사전순 비교 버그 회귀)', () => {
  // 46193 = 2026-06-20. 시리얼 그대로면 '2026-07-03' >= '46193' 이 사전순으로 false 가 되어
  // 매수했는데도 "미매수"로 오판 → 중복 매수 제안이 나가는 버그(2026-07-10 실측 발견).
  const conclusions = latestConclusions([nrow('46193', '삼성전자', '🟢 유효')]);
  assert.equal(conclusions.get('삼성전자').date, '2026-06-20');   // 시리얼 → ISO
  const execRows = [trow('2026-07-03 10:00', '매수', '삼성전자')];
  const out = buildBuyFromEval({ conclusions, execRows, holdings: [], cash: { 위탁: 3000000 } });
  assert.equal(out.length, 0);   // 평가 후 매수했으므로 제안 없음
});

test('buildHoldingsFacts: 등급·확신여부·목표·목표수익률을 보유 종목별로 조립', () => {
  const holdings = [
    { acct: '위탁', name: '삼성전자', assetType: '국내주식', qty: 40, evalWon: 11020000, unitKrw: 275500 },
    { acct: '위탁', name: 'SK하이닉스', assetType: '국내주식', qty: 5, evalWon: 10770000, unitKrw: 2154000 },
  ];
  const conclusions = new Map([
    ['삼성전자', { date: '2026-07-01', emoji: '🟢', isSell: false, concl: '🟢 유효 — 실적 개선', targetRet: '15' }],
  ]);
  const conviction = new Map([['SK하이닉스', '확신']]);
  // 포지션저널: idx0=이름, idx4=유형, idx6=목표, idx10=상태
  const journalRows = [
    ['삼성전자', '', '', '', '배분', '', '3개월 내 +15%', '', '', '', '보유'],
    ['SK하이닉스', '', '', '', '확신', '', '장기 보유', '', '', '', '보유'],
  ];
  const facts = buildHoldingsFacts({ holdings, conclusions, conviction, journalRows });
  assert.equal(facts.length, 2);
  const samsung = facts.find(f => f.name === '삼성전자');
  assert.equal(samsung.conviction, '배분');
  assert.equal(samsung.grade, '🟢');
  assert.equal(samsung.target, '3개월 내 +15%');
  assert.equal(samsung.targetRet, '15');
  const skhynix = facts.find(f => f.name === 'SK하이닉스');
  assert.equal(skhynix.conviction, '확신');   // 매도 후보 배제는 소비자가 이 필드로 판단
  assert.equal(skhynix.grade, null);          // 무평가
  assert.equal(skhynix.target, '장기 보유');
});

test('buildHoldingsFacts: 청산된 포지션의 목표는 제외(현재 보유만)', () => {
  const holdings = [{ acct: '위탁', name: '현대차', assetType: '국내주식', qty: 8, evalWon: 3856000, unitKrw: 482000 }];
  const journalRows = [
    ['현대차', '', '', '', '배분', '', '목표 A', '', '', '', '보유'],
    ['옛종목', '', '', '', '배분', '', '목표 B(청산됨·무시돼야 함)', '', '', '', '청산'],
  ];
  const facts = buildHoldingsFacts({ holdings, conclusions: new Map(), conviction: new Map(), journalRows });
  assert.equal(facts[0].target, '목표 A');
});

test('mk: export되어 order-proposals.mjs가 회전 매도 후보를 동일 계약으로 조립 가능', () => {
  const c = mk('회전', '위탁', '매도', '현대차', 8, 482000, { 회전: '연동 매도' });
  assert.equal(c.source, '회전');
  assert.equal(c.amount, 8 * 482000);
});

test('resolveRotationSell: 정상 케이스 — 보유·배분형 종목을 결정론 매도 후보로 조립', () => {
  const holdings = [{ acct: '위탁', name: '현대차', assetType: '국내주식', qty: 8, evalWon: 3856000, unitKrw: 482000 }];
  const rotatable = [{ name: '현대차', conviction: '배분' }];
  const { candidate, reason } = resolveRotationSell({
    sellName: '현대차', buyName: 'SK하이닉스', holdings, rotatable, isDuplicateKey: () => false,
  });
  assert.equal(reason, null);
  assert.equal(candidate.source, '회전');
  assert.equal(candidate.side, '매도');
  assert.equal(candidate.qty, 8);
  assert.equal(candidate.amount, 8 * 482000);
});

test('resolveRotationSell: 자기참조·미보유·확신종목·중복은 전부 candidate:null', () => {
  const holdings = [
    { acct: '위탁', name: '현대차', assetType: '국내주식', qty: 8, evalWon: 3856000, unitKrw: 482000 },
    { acct: '위탁', name: 'SK하이닉스', assetType: '국내주식', qty: 5, evalWon: 10770000, unitKrw: 2154000 },
  ];
  const rotatable = [{ name: '현대차', conviction: '배분' }];   // SK하이닉스는 확신이라 목록에 없음

  // 자기참조(매도 대상이 매수 후보 자신)
  assert.equal(resolveRotationSell({
    sellName: '현대차', buyName: '현대차', holdings, rotatable, isDuplicateKey: () => false,
  }).candidate, null);

  // 확신 종목(rotatable에 없음)
  assert.equal(resolveRotationSell({
    sellName: 'SK하이닉스', buyName: '가온전선', holdings, rotatable, isDuplicateKey: () => false,
  }).candidate, null);

  // 미보유(holdings에 없음)
  assert.equal(resolveRotationSell({
    sellName: '삼성전자', buyName: '가온전선', holdings, rotatable, isDuplicateKey: () => false,
  }).candidate, null);

  // 이미 대기/승인 중이거나 이번 실행에서 이미 나온 매도(중복)
  const dup = resolveRotationSell({
    sellName: '현대차', buyName: 'SK하이닉스', holdings, rotatable, isDuplicateKey: () => true,
  });
  assert.equal(dup.candidate, null);
  assert.match(dup.reason, /이미/);
});

test('applyThesisGuard: B🔴 매수 제외·B🟡 매수 유지+충돌플래그·매도는 무관', () => {
  const bSignals = latestRiskByType([
    rrow('2026-07-06', 'B', '테슬라', '🔴', '전제 붕괴'),
    rrow('2026-07-06', 'B', '현대차', '🟡', '영업이익 2분기 연속 감소'),
    rrow('2026-07-06', 'B', 'SK하이닉스', '🟢', '훼손 없음'),
  ], 'B');
  const cands = [
    { source: '급락O', side: '매수', name: '테슬라', why: {} },       // B🔴 → 제외
    { source: '급락O', side: '매수', name: '현대차', why: {} },       // B🟡 → 유지+플래그
    { source: '급락O', side: '매수', name: 'SK하이닉스', why: {} },   // B🟢 → clean
    { source: '급락O', side: '매수', name: '가온전선', why: {} },     // 무신호 → clean
    { source: '논리훼손B', side: '매도', name: '테슬라', why: {} },   // 매도는 가드 무관
  ];
  const { kept, dropped } = applyThesisGuard(cands, bSignals);
  assert.deepEqual(kept.map(c => c.name), ['현대차', 'SK하이닉스', '가온전선', '테슬라']);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].name, '테슬라');
  assert.equal(dropped[0].source, '급락O');       // 매도 테슬라는 kept, 매수 테슬라만 dropped
  assert.match(dropped[0].reason, /B🔴/);
  // 현대차만 충돌 플래그, 나머지 매수는 clean
  assert.match(kept.find(c => c.name === '현대차').why.논리충돌, /B🟡 논리약화/);
  assert.equal(kept.find(c => c.name === 'SK하이닉스').why.논리충돌, undefined);
  assert.equal(kept.find(c => c.name === '가온전선').why.논리충돌, undefined);
});

// 구조조정 안건7(2026-07-17) — 차단해제(B🔴→비🔴 전환)가 코드상 아무 감지 없이 자동·조용히
// 통과되던 것을 리허설로 발견해 게이트화. 최초 설계는 detectThesisReleases가 리스크모니터
// 시트 이력에서 직접 전환을 재구성했으나, pruneRiskSheet가 종목당 최신 B행 1개만 남겨(이력
// 소멸) 절대 발동 안 하는 죽은 게이트였음(code-reviewer 지적) — risk-monitor.mjs가 전환 시점에
// 별도 영구 로그(차단해제이력)에 남기고, detectThesisReleases는 그 로그를 파싱만 한다.
test('detectThesisReleases: 차단해제이력 로그 파싱 — 14일 이내만, 종목당 최신 감지만', () => {
  const releases = detectThesisReleases([
    relrow('2026-07-06 09:00:00', '테슬라', '2026-06-01', '2026-07-06', '🟢'),   // 최근 → 대상
    relrow('2026-06-01 09:00:00', '현대차', '2026-05-01', '2026-06-01', '🟡'),   // 14일 초과 → 창밖(제외)
    relrow('2026-06-25 09:00:00', 'SK하이닉스', '2026-06-01', '2026-06-25', '🟢'),
    relrow('2026-07-02 09:00:00', 'SK하이닉스', '2026-06-25', '2026-07-02', '🟢'), // 같은 종목 재감지 → 최신만
  ], '2026-07-14');
  assert.deepEqual([...releases.keys()].sort(), ['SK하이닉스', '테슬라']);
  const tesla = releases.get('테슬라');
  assert.equal(tesla.from, '2026-06-01'); assert.equal(tesla.to, '2026-07-06'); assert.equal(tesla.newSignal, '🟢');
  assert.equal(releases.get('SK하이닉스').detectedAt, '2026-07-02 09:00:00');   // 06-25건 아니라 최신(07-02)
});

test('detectThesisReleases: 경계값 — 정확히 14일 전 감지는 포함(그날까지는 Zeus 검토 창)', () => {
  const releases = detectThesisReleases(
    [relrow('2026-06-30 09:00:00', '카카오', '2026-06-01', '2026-06-30', '🟢')], '2026-07-14');
  assert.equal(releases.size, 1);   // 2026-07-14 - 14일 = 2026-06-30, 경계 포함
});

test('detectThesisReleases: todayStr 미전달 시 창 제한 없이 전부 반환(하위호환)', () => {
  const releases = detectThesisReleases([relrow('2020-01-01 00:00:00', '오래된종목', '2019-01-01', '2020-01-01', '🟢')]);
  assert.equal(releases.size, 1);
});

test('applyThesisGuard: 막 회복(releases) 매수 후보는 통과하되 차단해제대기 플래그 부착', () => {
  const bSignals = latestRiskByType([rrow('2026-07-06', 'B', '테슬라', '🟢', '펀더멘털 회복 확인')], 'B');
  const releases = detectThesisReleases(
    [relrow('2026-07-06 09:00:00', '테슬라', '2026-06-01', '2026-07-06', '🟢')], '2026-07-14');
  const cands = [{ source: '급락O', side: '매수', name: '테슬라', why: {} }];
  const { kept, dropped } = applyThesisGuard(cands, bSignals, releases);
  assert.equal(dropped.length, 0);            // 자동 차단 아님 — 통과
  assert.equal(kept.length, 1);
  assert.match(kept[0].why.차단해제대기, /B🔴\(2026-06-01\)→🟢\(2026-07-06\)/);
  assert.match(kept[0].why.차단해제대기, /Zeus 반대검증/);
});

test('applyThesisGuard: releases 미전달(기존 호출부 하위호환) 시 차단해제대기 없음', () => {
  const bSignals = latestRiskByType([rrow('2026-07-06', 'B', 'SK하이닉스', '🟢', '훼손 없음')], 'B');
  const { kept } = applyThesisGuard([{ source: '급락O', side: '매수', name: 'SK하이닉스', why: {} }], bSignals);
  assert.equal(kept[0].why.차단해제대기, undefined);
});

test('checkConstraints: why.차단해제대기 있으면 차단해제확인 ✗ 체크 산출(매수)', () => {
  const checks = checkConstraints(
    { side: '매수', acct: '위탁', name: '테슬라', amount: 964000, why: { 차단해제대기: 'B🔴(2026-06-01)→🟢(2026-07-06) 최근 회복 — Zeus 반대검증 확인 필요' } },
    { cash: { 위탁: 1200000 }, conviction: new Map() });
  const check = checks.find(x => x.k === '차단해제확인');
  assert.equal(check.ok, false);
  assert.match(check.d, /반대검증/);
});

test('checkConstraints: why.논리충돌 있으면 논리상태 ✗ 체크 산출(매수)', () => {
  const checks = checkConstraints(
    { side: '매수', acct: '위탁', name: '현대차', amount: 964000, why: { 논리충돌: 'B🟡 논리약화 (2026-07-06) — 수익성 압박' } },
    { cash: { 위탁: 1200000 }, conviction: new Map() });
  const logic = checks.find(x => x.k === '논리상태');
  assert.equal(logic.ok, false);
  assert.match(logic.d, /B🟡/);
});

test('makeMatchKey + RULE500 상수', () => {
  assert.equal(makeMatchKey({ acct: '위탁', name: '삼성전자', side: '매수' }), '위탁|삼성전자|매수');
  assert.equal(RULE500_WON, 5000000);
});

// ── isCashLike 정합 테스트 ────────────────────────────────────────────────────
// parseSheetData.isCashLike · movers.isCashLike · order-candidates.isCashLike 는
// "동일 집합(예수금·외화 RP·MMF 포함, 공백 trim)"을 공유해야 한다.
// 세 구현이 모두 trim() 후 비교하므로 픽스처에서 공백 변형도 포함해 검증한다.
// order-candidates.isCashLike 는 export 없으므로 parseHoldingRows 경유로 간접 검증.
test('isCashLike 정합: 공유 픽스처 — 예수금·외화 RP·MMF 변형 모두 현금성 제외', () => {
  // { name, expectCashLike } 픽스처
  // parseHoldingRows 는 isCashLike=true 인 행을 결과에서 제외한다(필터).
  const cashNames   = ['예수금', '예수금 ', ' 예수금', '외화 RP', '외화 RP ', ' 외화 RP', '삼성신종종류형 MMF 제4호'];
  const normalNames = ['삼성전자', '', '예수금X', '예수금포함'];  // MMF·외화RP·예수금 정확 일치 아닌 경우

  // qty(idx3)=1, evalWon(idx7)=1000000 — parseHoldingRows qty>0·evalWon>0 필터 통과용
  const makeRows = (names) =>
    names.map((name) => ['국내주식', name, '', '1', '', '', '', '1000000']);

  const cashRows   = makeRows(cashNames);
  const normalRows = makeRows(normalNames).filter(r => r[1] !== '');  // 빈 name 은 파서가 skip

  // 현금성 픽스처 → parseHoldingRows 결과에서 모두 제외돼야 함
  const cashHoldings = parseHoldingRows('위탁', cashRows);
  assert.equal(cashHoldings.length, 0, `현금성 행이 주문 후보에 포함됨: ${JSON.stringify(cashHoldings.map(h => h.name))}`);

  // 일반 픽스처 → parseHoldingRows 결과에 포함돼야 함 (qty=1 이므로 필터 통과)
  // '예수금X', 'MMF예수금' 은 isCashLike=false 이므로 포함
  const normalHoldings = parseHoldingRows('위탁', normalRows);
  const normalParsedNames = normalHoldings.map(h => h.name);
  for (const name of ['삼성전자', '예수금X', '예수금포함']) {
    assert.ok(normalParsedNames.includes(name), `'${name}'이 일반 종목으로 포함돼야 함`);
  }
});
