import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveExecutionAccount } from './account-resolver.mjs';

test('삼성증권은 항상 연금저축(1:1 확정)', () => {
  assert.equal(resolveExecutionAccount({ broker: '삼성증권', stockName: '아무거나' }, []), '연금저축');
});

// 2026-08-13 수정 — 한국투자증권이 이제 IRP·퀀트 두 계좌를 호스팅해 증권사명만으로는
// 더 이상 유일하게 안 풀린다(NH의 ISA/위탁 문제와 같은 클래스). 계좌번호(acctNo)로
// 구분한다 — 실제 알림 원문 예시(오너 제공)로 고정.
test('[막아야 함] 한국투자증권 — 계좌번호로 IRP를 확정(증권사명만으론 더 이상 확정 못 함)', () => {
  assert.equal(resolveExecutionAccount({ broker: '한국투자증권', stockName: '아무거나', acctNo: '43****82-29' }, []), 'IRP');
});

test('[막아야 함] 한국투자증권 — 계좌번호가 퀀트 계좌면 null(State/Holdings 반영 금지, KIS API가 정본)', () => {
  assert.equal(resolveExecutionAccount({ broker: '한국투자증권', stockName: '아무거나', acctNo: '46****07-01' }, []), null);
});

test('[막아야 함] 한국투자증권 — 계좌번호를 못 뽑았으면(옛 형식 등) 더 이상 IRP로 추정하지 않고 null', () => {
  assert.equal(resolveExecutionAccount({ broker: '한국투자증권', stockName: '아무거나' }, []), null);
});

test('한국투자증권 — 모르는 계좌번호(신규 계좌 등)면 추정하지 않고 null', () => {
  assert.equal(resolveExecutionAccount({ broker: '한국투자증권', stockName: '아무거나', acctNo: '99****99-99' }, []), null);
});

test('NH — 종목이 ISA에만 있으면 ISA로 확정', () => {
  const holdings = [{ account: 'ISA', name: 'TIGER 배당성장' }];
  assert.equal(resolveExecutionAccount({ broker: 'NH투자증권', stockName: 'TIGER 배당성장' }, holdings), 'ISA');
});

test('NH — 종목이 위탁에만 있으면 위탁으로 확정', () => {
  const holdings = [{ account: '위탁', name: '삼성전자' }];
  assert.equal(resolveExecutionAccount({ broker: 'NH투자증권', stockName: '삼성전자' }, holdings), '위탁');
});

test('NH — 신규 종목(어느 쪽에도 없음)은 추정하지 않고 null', () => {
  assert.equal(resolveExecutionAccount({ broker: 'NH투자증권', stockName: '처음보는종목' }, []), null);
});

test('NH — 같은 종목명이 ISA·위탁 양쪽에 다 있으면 추정하지 않고 null', () => {
  const holdings = [
    { account: 'ISA', name: 'KODEX 배당' },
    { account: '위탁', name: 'KODEX 배당' },
  ];
  assert.equal(resolveExecutionAccount({ broker: 'NH투자증권', stockName: 'KODEX 배당' }, holdings), null);
});

test('NH — 다른 계좌(연금저축)에만 같은 이름이 있어도 후보 밖이라 무시하고 null', () => {
  const holdings = [{ account: '연금저축', name: '겹치는이름' }];
  assert.equal(resolveExecutionAccount({ broker: 'NH투자증권', stockName: '겹치는이름' }, holdings), null);
});

test('[막아야 함] NH — 금현물(실물 금) 매수도 후보에 포함(2026-08-18 수정 — 예전엔 없어서 실제 금 매수가 생기면 영원히 계좌귀속불가였을 잠재 버그)', () => {
  const holdings = [{ account: '금현물', name: 'KRX금99.99K' }];
  assert.equal(resolveExecutionAccount({ broker: 'NH투자증권', stockName: 'KRX금99.99K' }, holdings), '금현물');
});

test('NH — CMA는 여전히 후보 밖(순수 현금 경유지라 증권 보유 불가, 오너 확정)', () => {
  const holdings = [{ account: 'CMA', name: '어쩌다생긴이름' }];
  assert.equal(resolveExecutionAccount({ broker: 'NH투자증권', stockName: '어쩌다생긴이름' }, holdings), null);
});

test('NH 해외(overseas) 브로커명도 동일 후보군으로 취급', () => {
  const holdings = [{ account: '위탁', name: 'VOO' }];
  assert.equal(resolveExecutionAccount({ broker: 'NH투자증권 해외', stockName: 'VOO' }, holdings), '위탁');
});

test('알 수 없는 증권사는 안전하게 null', () => {
  assert.equal(resolveExecutionAccount({ broker: '미지의증권사', stockName: '종목' }, []), null);
});

// 코드리뷰 지적(2026-08-05): 종목명만 보면, ISA에 있는 "X"와 실제로 사려는 위탁의 "X"가
// 이름만 같고 다른 상품일 때 잘못 확정될 위험이 있다 — stockCode·ticker가 둘 다 있으면
// 반드시 일치해야 후보로 인정한다.
test('NH — stockCode와 ticker가 있으면 종목명이 같아도 코드가 다르면 불일치로 제외', () => {
  const holdings = [{ account: 'ISA', name: 'X', ticker: '000001' }];
  assert.equal(resolveExecutionAccount({ broker: 'NH투자증권', stockName: 'X', stockCode: '000002' }, holdings), null);
});

test('NH — stockCode와 ticker가 일치하면 정상 확정', () => {
  const holdings = [{ account: 'ISA', name: 'X', ticker: '000001' }];
  assert.equal(resolveExecutionAccount({ broker: 'NH투자증권', stockName: 'X', stockCode: '000001' }, holdings), 'ISA');
});

test('NH — ticker가 빈 문자열(마이그레이션 보유)이면 종목명만으로 폴백(정상 케이스가 미해결로 밀리면 안 됨)', () => {
  const holdings = [{ account: 'ISA', name: 'X', ticker: '' }];
  assert.equal(resolveExecutionAccount({ broker: 'NH투자증권', stockName: 'X', stockCode: '000001' }, holdings), 'ISA');
});
