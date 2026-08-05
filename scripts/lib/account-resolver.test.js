import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveExecutionAccount } from './account-resolver.mjs';

test('삼성증권은 항상 연금저축(1:1 확정)', () => {
  assert.equal(resolveExecutionAccount({ broker: '삼성증권', stockName: '아무거나' }, []), '연금저축');
});

test('한국투자증권은 항상 IRP(1:1 확정)', () => {
  assert.equal(resolveExecutionAccount({ broker: '한국투자증권', stockName: '아무거나' }, []), 'IRP');
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
