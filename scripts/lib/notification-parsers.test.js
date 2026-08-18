// notification-parsers.mjs 테스트 — 증권사별 카카오 알림 원문 파싱.
// v1(parse-notifications.mjs)에서 추출된 로직이라 이전엔 테스트가 없었다(구현계획서
// Phase 2, 2026-08-04) — 이번에 처음으로 회귀 테스트를 붙인다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanNum, normalizeDateTime,
  parseExecution, parseDividend, parseFundBuy, parseGoldBuy, parseCashAlarm, parseExchange,
} from './notification-parsers.mjs';

test('cleanNum: 콤마 제거, allowDot으로 소수점 유지 여부 제어', () => {
  assert.equal(cleanNum('71,000'), '71000');
  assert.equal(cleanNum('71,000.5', true), '71000.5');
  assert.equal(cleanNum('71,000.5'), '710005'); // allowDot 없으면 점도 제거
});

test('normalizeDateTime: leading-zero 보정', () => {
  assert.equal(normalizeDateTime('2026-5-4 9:20:42'), '2026-05-04 09:20:42');
  assert.equal(normalizeDateTime('2026-08-04 09:20:42'), '2026-08-04 09:20:42');
  assert.equal(normalizeDateTime('이상한값'), '이상한값'); // 매칭 실패 시 원문 trim만
});

test('parseExecution: NH투자증권 국내 체결', () => {
  const body = '[NH투자증권]\n매수체결통보\n종목명 : 삼성전자\n종목코드 : 005930\n체결수량 : 10주\n체결단가 : 71,000원';
  const r = parseExecution(body, '2026-08-04 09:12:33');
  assert.deepEqual(r, {
    tradeDate: '2026-08-04 09:12:33',
    tradeType: '매수',
    stockCode: '005930',
    stockName: '삼성전자',
    quantity: 10,
    price: 71000,
    currency: 'KRW',
    broker: 'NH투자증권',
    acctNo: '',
  });
});

test('parseExecution: NH투자증권 해외 체결(USD)', () => {
  const body = '[NH투자증권] 해외주식 매수체결\n종목명 : (AAPL O)애플\n체결수량 : 5주\n체결가격 : 210.50';
  const r = parseExecution(body, '2026-08-04 22:30:00');
  assert.equal(r.stockCode, 'AAPL');
  assert.equal(r.stockName, '애플');
  assert.equal(r.currency, 'USD');
  assert.equal(r.price, 210.5);
});

test('parseExecution: 삼성증권 매도 체결', () => {
  const body = '[삼성증권]<주식체결안내>\n계좌: 71612-****\nKODEX 200\n매도10주 30,500원';
  const r = parseExecution(body, '2026-08-04 10:00:00');
  assert.equal(r.tradeType, '매도');
  assert.equal(r.stockName, 'KODEX 200');
  assert.equal(r.quantity, 10);
  assert.equal(r.price, 30500);
});

test('parseExecution: 한국투자증권 체결(계좌번호 없는 옛 형식도 여전히 파싱됨)', () => {
  const body = '[한국투자증권 체결안내]\n매수 체결되었습니다\n종목명 : TIGER 미국나스닥100(133690)\n체결수량 : 3주\n체결단가 : 105,000원';
  const r = parseExecution(body, '2026-08-04 11:00:00');
  assert.equal(r.stockCode, '133690');
  assert.equal(r.stockName, 'TIGER 미국나스닥100');
  assert.equal(r.quantity, 3);
  assert.equal(r.acctNo, '');
});

// 2026-08-13 오너가 실제 알림 원문을 붙여 확인 — 한국투자증권 체결안내엔 계좌번호가
// 있었다(IRP·퀀트 두 계좌를 구분해야 하는 실제 계기가 된 예시). 이 계좌번호로
// account-resolver.mjs가 증권사명보다 우선해서 계좌를 확정한다.
test('[막아야 함] parseExecution: 한국투자증권 체결 — 계좌번호를 캡처해 IRP/퀀트를 구분할 수 있다', () => {
  const irpBody = '[한국투자증권 체결안내]11:04\n\n*계좌번호:43****82-29\n*계좌명:정영호\n*매매구분:현금매수체결\n*종목명:TIGER TDF2045 적격(0025N0)\n*체결수량:4주\n*체결단가:12,220원\n\n*주문수량:4주\n*총체결수량:4주\n*주문번호:3989900';
  const quantBody = '[한국투자증권 체결안내]09:41\n\n*계좌번호:46****07-01\n*계좌명:정영호\n*매매구분:현금매수체결\n*종목명:SK텔레콤(017670)\n*체결수량:1주\n*체결단가:87,500원\n\n*주문수량:1주\n*총체결수량:1주\n*주문번호:6693100';

  const irp = parseExecution(irpBody, '2026-08-12 11:04:00');
  const quant = parseExecution(quantBody, '2026-08-12 09:41:00');
  assert.equal(irp.acctNo, '43****82-29');
  assert.equal(irp.stockName, 'TIGER TDF2045 적격');
  assert.equal(quant.acctNo, '46****07-01');
  assert.equal(quant.stockName, 'SK텔레콤');
  assert.notEqual(irp.acctNo, quant.acctNo); // 같은 증권사, 다른 계좌 — 이게 이번 수정의 핵심
});

test('parseExecution: 체결·매수/매도 키워드 없으면 null', () => {
  assert.equal(parseExecution('그냥 광고 메시지입니다', '2026-08-04 00:00:00'), null);
});

test('parseExecution: 패턴에 안 걸리는 형식 불량 본문은 null', () => {
  const body = '[NH투자증권] 체결 매수인데 형식이 다름';
  assert.equal(parseExecution(body, '2026-08-04 00:00:00'), null);
});

test('parseDividend: NH 배당금 입금 안내', () => {
  const body = '[NH투자증권] 배당금 입금 안내\n종목명 : TIGER 리츠부동산인프라\n세후금액 : 15,000원\n입금일 : 2026.08.04';
  const r = parseDividend(body, '2026-08-04 09:00:00');
  assert.equal(r.date, '2026-08-04');
  assert.equal(r.afterTaxAmount, 15000);
  assert.equal(r.stockName, 'TIGER 리츠부동산인프라');
  assert.equal(r.uniqueKey, '09:00:00_15000');
});

test('parseDividend: NH 채권원리금 입금 안내', () => {
  const body = '[NH투자증권] 채권원리금 입금 안내\n계좌 입금 08/04 09:30 500,000 삼척블루파워12';
  const r = parseDividend(body, '2026-08-04 09:30:00');
  assert.equal(r.date, '2026-08-04');
  assert.equal(r.afterTaxAmount, 500000);
  assert.equal(r.stockName, '삼척블루파워12');
});

test('parseDividend: 삼성증권 분배금', () => {
  const body = '[삼성증권] <분배금 지급 안내>\n종목명 : KODEX 200\n세후 분배금액 : 3,200원';
  const r = parseDividend(body, '2026-08-04 09:00:00');
  assert.equal(r.afterTaxAmount, 3200);
  assert.equal(r.stockName, 'KODEX 200');
});

test('parseDividend: 배당·분배금·채권원리금 키워드 없으면 null', () => {
  assert.equal(parseDividend('그냥 알림', '2026-08-04 00:00:00'), null);
});

test('parseFundBuy: 삼성증권 펀드 매수 완료 안내', () => {
  const body = '펀드 매수 완료 안내\n펀드명 : VIP한국형가치투자증권자투자신탁(주식)-C-Pe\n매수금액 : 500,000원\n매수기준가 : 1,200.50\n매수신청일 : 2026년 8월 4일';
  const r = parseFundBuy(body, '2026-08-04 09:00:00');
  assert.equal(r.fundName, 'VIP한국형가치투자증권자투자신탁(주식)-C-Pe');
  assert.equal(r.amount, 500000);
  assert.equal(r.nav, 1200.5);
  assert.equal(r.date, '2026-08-04');
  assert.equal(Math.round(r.units), Math.round((500000 / 1200.5) * 1000));
});

test('parseFundBuy: 펀드·매수기준가 키워드 없으면 null', () => {
  assert.equal(parseFundBuy('일반 알림', '2026-08-04 00:00:00'), null);
});

test('parseGoldBuy: NH 금현물 매수 체결(g 단위)', () => {
  const body = '체결통보\n종목명 : KRX금99.99K\n체결수량 : 10.5g\n체결단가 : 95,000원\n주문번호 : 12345\n매수';
  const r = parseGoldBuy(body, '2026-08-04 09:00:00');
  assert.equal(r.stockName, 'KRX금99.99K');
  assert.equal(r.qty, 10.5);
  assert.equal(r.price, 95000);
  assert.equal(r.tradeType, '매수');
  assert.equal(r.orderNo, '12345');
});

test('parseGoldBuy: 매도도 지원(동일 포맷 가정)', () => {
  const body = '체결통보\n종목명 : KRX금99.99K\n체결수량 : 5g\n체결단가 : 96,000원\n매도';
  const r = parseGoldBuy(body, '2026-08-04 09:00:00');
  assert.equal(r.tradeType, '매도');
});

test('parseGoldBuy: 주 단위(일반 주식)는 매칭 안 됨(g 가드)', () => {
  const body = '체결통보\n종목명 : 삼성전자\n체결수량 : 10주\n체결단가 : 71,000원\n매수';
  assert.equal(parseGoldBuy(body, '2026-08-04 09:00:00'), null);
});

test('[막아야 함/날짜절삭 재발방지] parseGoldBuy: date가 날짜만이 아니라 전체 타임스탬프(시각 보존) — cash-ledger.mjs 델타 비교가 사전식으로 안전하려면 필수', () => {
  const body = '체결통보\n종목명 : KRX금99.99K\n체결수량 : 10.5g\n체결단가 : 95,000원\n매수';
  const r = parseGoldBuy(body, '2026-08-04 13:02:15');
  assert.equal(r.date, '2026-08-04 13:02:15');
});

test('parseCashAlarm: NH 위탁 입금안내(정상 — 출금가능금액이 입금 반영)', () => {
  const body = '[NH투자증권] 입금안내\n계좌번호 205-01-59***9\n금액 1,000,000원\n출금가능금액 : 7,224,098원';
  const r = parseCashAlarm(body, '2026-08-04 09:00:00');
  assert.equal(r.account, '위탁');
  assert.equal(r.acctNo, '205-01-59***9');
  assert.equal(r.balance, 7224098); // 위탁은 출금가능금액이 이미 정확 → 그대로
});

test('parseCashAlarm: NH ISA 입금안내(출금가능금액이 입금보다 작아 뒤처짐 — 입금액 우선)', () => {
  const body = '[NH투자증권] 입금안내\n계좌번호 209-02-89***2\n금액 300,000원\n출금가능금액 : 183,079원';
  const r = parseCashAlarm(body, '2026-08-04 09:00:00');
  assert.equal(r.account, 'ISA');
  assert.equal(r.balance, 300000); // resolveDepositAnchorBalance가 더 큰 입금액 채택
});

test('[막아야 함] parseCashAlarm: 접두사(209-02)가 같은 금현물 계좌는 ISA와 섞이지 않음', () => {
  // 실제 사고 재현 방지 회귀 테스트(2026-08-18 실데이터로 발견) — ISA와 금현물이
  // 209-02 접두사를 공유해, 접두사만 보던 예전 방식이면 금현물 알림이 ISA로 잘못 들어감.
  const body = '[NH투자증권] 출금안내\n계좌번호 209-02-92***6\n금액 200,000원\n출금가능금액 : 50,000원';
  const r = parseCashAlarm(body, '2026-08-04 09:00:00');
  assert.equal(r.account, '금현물');
});

test('parseCashAlarm: NH CMA 입금안내(경유지 계좌도 계좌명으로 정확히 식별)', () => {
  const body = '[NH투자증권] 입금안내\n계좌번호 209-01-92***6\n금액 2,000,000원\n출금가능금액 : 25,103,085원';
  const r = parseCashAlarm(body, '2026-08-04 09:00:00');
  assert.equal(r.account, 'CMA');
  assert.equal(r.balance, 25103085);
});

test('parseCashAlarm: 매핑 안 된 NH 계좌는 null(추정 안 함)', () => {
  const body = '[NH투자증권] 입금안내\n계좌번호 999-99-000000\n금액 100,000원\n출금가능금액 : 100,000원';
  assert.equal(parseCashAlarm(body, '2026-08-04 09:00:00'), null);
});

test('parseCashAlarm: NH투자증권 아니면 null', () => {
  assert.equal(parseCashAlarm('[삼성증권] 입금안내', '2026-08-04 09:00:00'), null);
});

test('parseExchange: 외화매수(원화→USD)', () => {
  const body = '환전내역 안내\n환전일자 : 8월 4일\n환전구분 : 외화매수\n통화명 : USD\n외화금액 : USD 1,000.00\n원화금액 : 1,350,000';
  const r = parseExchange(body, '2026-08-04 09:00:00');
  assert.equal(r.kind, '외화매수');
  assert.equal(r.usd, 1000);
  assert.equal(r.won, 1350000);
  assert.equal(r.date, '2026-08-04');
});

test('parseExchange: USD 외 통화는 null', () => {
  const body = '환전내역 안내\n환전구분 : 외화매수\n통화명 : JPY\n외화금액 : USD 100';
  assert.equal(parseExchange(body, '2026-08-04 09:00:00'), null);
});

test('parseExchange: 원화금액 파싱 실패해도 USD 쪽은 반환(won=null)', () => {
  const body = '환전내역 안내\n환전구분 : 외화매도\n외화금액 : USD 500.00';
  const r = parseExchange(body, '2026-08-04 09:00:00');
  assert.equal(r.usd, 500);
  assert.equal(r.won, null);
});
