// 예수금 base 앵커 결정(resolveCashBase) 테스트.
// 핵심 회귀: NH(ISA·위탁) 입금/출금 알림이 '소스=수동'에 의해 영구 무시되어 입금이
// 예수금에 반영되지 않던 버그. 알림이 수동 기준일보다 '엄격히 최신'이면 알림을 우선한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCashBase, parseAmount, settleCash, buildHistoricalAcctMap, resolveTradeTab } from './cash-base.mjs';

const cfg = (base, date, source) => ({ base, date, source, rowNum: 2 });
const anchor = (balance, ts) => ({ balance, ts });

test('parseAmount: 콤마 제거·정수화, 빈값/비숫자는 null', () => {
  assert.equal(parseAmount('296,000'), 296000);
  assert.equal(parseAmount('5,158,650'), 5158650);
  assert.equal(parseAmount(984832), 984832);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount(null), null);
  assert.equal(parseAmount('abc'), null);
});

test('[버그수정] 수동 기준보다 최신 NH 알림이 오면 알림을 앵커로 우선', () => {
  // ISA 실제 사고: 수동 296,000@6/19 고착, 6/24 입금알림 984,832 무시됨 → 음수.
  const r = resolveCashBase({
    cfg: cfg('296,000', '2026-06-19', '수동'),
    anchor: anchor(984832, '2026-06-24 12:30:43'),
    isAutoTab: true,
  });
  assert.equal(r.base, 984832);
  assert.equal(r.baseDate, '2026-06-24');
  assert.equal(r.autoUpdated, true);   // 예수금기준 표를 '자동'으로 갱신해야 함
});

test('같은 날 수동 입력은 존중(엄격히 최신 알림만 우선)', () => {
  const r = resolveCashBase({
    cfg: cfg('296,000', '2026-06-24', '수동'),
    anchor: anchor(984832, '2026-06-24 12:30:43'),
    isAutoTab: true,
  });
  assert.equal(r.base, 296000);        // 사용자가 그날 직접 고친 값 존중
  assert.equal(r.baseDate, '2026-06-24');
  assert.equal(r.autoUpdated, false);
});

test('비수동(자동) NH 계좌: 알림이 기준일 이상이면 우선 — 기존 동작 보존', () => {
  const r = resolveCashBase({
    cfg: cfg('100000', '2026-06-19', '자동'),
    anchor: anchor(200000, '2026-06-24 09:00:00'),
    isAutoTab: true,
  });
  assert.equal(r.base, 200000);
  assert.equal(r.baseDate, '2026-06-24');
  assert.equal(r.autoUpdated, true);
});

test('알림이 수동 기준일보다 과거면 수동 유지(알림 무시)', () => {
  const r = resolveCashBase({
    cfg: cfg('296,000', '2026-06-24', '수동'),
    anchor: anchor(100000, '2026-06-19 09:00:00'),
    isAutoTab: true,
  });
  assert.equal(r.base, 296000);
  assert.equal(r.autoUpdated, false);
});

test('NH 알림이 없으면 수동 기준 사용', () => {
  const r = resolveCashBase({
    cfg: cfg('296,000', '2026-06-19', '수동'),
    anchor: null,
    isAutoTab: true,
  });
  assert.equal(r.base, 296000);
  assert.equal(r.baseDate, '2026-06-19');
  assert.equal(r.autoUpdated, false);
});

test('비-NH 계좌(연금저축·IRP): 알림 무시하고 수동 기준만', () => {
  const r = resolveCashBase({
    cfg: cfg('524,000', '2026-06-24', '수동'),
    anchor: anchor(999999, '2026-06-25 09:00:00'),   // 들어와도
    isAutoTab: false,                                 // 비-NH라 무시
  });
  assert.equal(r.base, 524000);
  assert.equal(r.baseDate, '2026-06-24');
  assert.equal(r.autoUpdated, false);
});

test('기준 미입력(cfg 없음)이고 알림도 없으면 base=null', () => {
  const r = resolveCashBase({ cfg: null, anchor: null, isAutoTab: true });
  assert.equal(r.base, null);
});

test('기준 미입력이지만 NH 알림이 있으면 알림으로 초기화', () => {
  const r = resolveCashBase({ cfg: null, anchor: anchor(500000, '2026-06-24 09:00:00'), isAutoTab: true });
  assert.equal(r.base, 500000);
  assert.equal(r.baseDate, '2026-06-24');
  assert.equal(r.autoUpdated, true);
});

test('수동 base 는 있으나 기준일이 빈 문자열이면 날짜 있는 알림이 우선', () => {
  // anchorDate > '' 는 항상 참 — 날짜 없는 base 는 dated 알림에 양보해야 한다.
  const r = resolveCashBase({
    cfg: cfg('296,000', '', '수동'),
    anchor: anchor(984832, '2026-06-24 12:30:43'),
    isAutoTab: true,
  });
  assert.equal(r.base, 984832);
  assert.equal(r.baseDate, '2026-06-24');
  assert.equal(r.autoUpdated, true);
});

test('settleCash: 양수·0은 그대로, 음수는 0 클램프+negative 플래그', () => {
  assert.deepEqual(settleCash(1000000, -300000), { cash: 700000, raw: 700000, negative: false });
  assert.deepEqual(settleCash(500000, -500000), { cash: 0, raw: 0, negative: false });
  // 입금 누락으로 매수 델타만 빠진 상황 — 음수는 0으로 막고 raw는 보존(경고 진단용)
  assert.deepEqual(settleCash(100000, -390600), { cash: 0, raw: -290600, negative: true });
  // null 방어
  assert.deepEqual(settleCash(null, null), { cash: 0, raw: 0, negative: false });
});

const VALID_TABS = ['ISA', '위탁', '연금저축', 'IRP'];
const execRow = (tab, name) => ['2026-07-01', '매수', tab, '', '국내주식', name];

test('[버그수정] 전량매도로 보유행이 지워진 종목 — 체결내역 폴백으로 계좌 복원', () => {
  // 2026-07-13 사고: 삼성바이오로직스 전량매도 후 보유행 소멸(clearRowsRaw) →
  // 현재 보유 스캔(portfolioMap)엔 없지만, 체결내역엔 계좌가 이미 기록돼 있다.
  const hist = buildHistoricalAcctMap(
    [execRow('위탁', '삼성바이오로직스'), execRow('위탁', 'SK하이닉스')],
    { tabCol: 2, nameCol: 5, validTabs: VALID_TABS },
  );
  assert.equal(resolveTradeTab('삼성바이오로직스', null, hist), '위탁');
});

test('현재 보유 스캔에 있으면 그것을 우선(체결내역 폴백보다 최신 실측 신뢰)', () => {
  const hist = buildHistoricalAcctMap([execRow('IRP', '삼성전자')], { tabCol: 2, nameCol: 5, validTabs: VALID_TABS });
  assert.equal(resolveTradeTab('삼성전자', 'ISA', hist), 'ISA');
});

test('같은 종목명이 서로 다른 계좌에 기록된 적 있으면(모호) 폴백 포기 — 오귀속보다 누락 경고가 안전', () => {
  const hist = buildHistoricalAcctMap(
    [execRow('ISA', 'TIGER 미국배당다우존스'), execRow('연금저축', 'TIGER 미국배당다우존스')],
    { tabCol: 2, nameCol: 5, validTabs: VALID_TABS },
  );
  assert.equal(resolveTradeTab('TIGER 미국배당다우존스', null, hist), null);
});

test('체결내역에도 없는 종목은 null(누락 경고 대상)', () => {
  const hist = buildHistoricalAcctMap([execRow('위탁', 'SK하이닉스')], { tabCol: 2, nameCol: 5, validTabs: VALID_TABS });
  assert.equal(resolveTradeTab('없는종목', null, hist), null);
});

test('[버그수정] 현재 2개 계좌에 동시보유 중인 종목명은 이력이 하나뿐이어도 폴백 거부', () => {
  // KRW 체결 알림엔 계좌번호가 없어 portfolioMap 이 dupNames 를 의도적으로 제외(liveTab=null).
  // 한쪽 계좌엔 체결내역이 없어 hist.map 에 계좌가 하나만 남는 비대칭 상황이어도, dupNames 는
  // 이력과 무관하게 항상 거부해야 한다 — 안 그러면 portfolioMap 의 배제가 폴백에서 무력화된다.
  const hist = buildHistoricalAcctMap([execRow('ISA', 'TIGER 리츠부동산인프라')], { tabCol: 2, nameCol: 5, validTabs: VALID_TABS });
  const dupNames = new Set(['TIGER 리츠부동산인프라']);   // 현재 ISA·위탁 동시 보유
  assert.equal(resolveTradeTab('TIGER 리츠부동산인프라', null, hist, dupNames), null);
});

test('buildHistoricalAcctMap: 계좌·종목명 빈값이나 허용 계좌 외는 무시', () => {
  const hist = buildHistoricalAcctMap(
    [execRow('', '이름있음'), execRow('위탁', ''), execRow('알수없는계좌', '아무개')],
    { tabCol: 2, nameCol: 5, validTabs: VALID_TABS },
  );
  assert.equal(hist.map.size, 0);
});
