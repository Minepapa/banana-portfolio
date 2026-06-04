import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonName, canonCode, sameStock } from './stockIdentity.js';

test('canonName: 공백/대소문자/NFC 정규화', () => {
  assert.equal(canonName(' 삼성  전자 '), '삼성 전자');
  assert.equal(canonName('Apple'), 'apple');
  assert.equal(canonName('삼성전자'), canonName('삼성전자 '));
});

test('canonName: 우선주 등 괄호는 보존(거짓 병합 방지)', () => {
  assert.notEqual(canonName('삼성전자'), canonName('삼성전자(우)'));
});

test('canonCode: trim + 대문자', () => {
  assert.equal(canonCode(' aapl '), 'AAPL');
  assert.equal(canonCode('005930'), '005930');
});

test('sameStock: 코드가 둘 다 있으면 코드로 판정(이름 달라도 일치)', () => {
  assert.equal(sameStock('005930', '삼성전자', '005930', '삼성 전자'), true);
  assert.equal(sameStock('AAPL', '애플', 'AAPL', 'Apple Inc'), true);
});

test('sameStock: 코드가 한쪽이라도 없으면 정규화 이름으로 판정', () => {
  assert.equal(sameStock('', '삼성 전자', '', '삼성전자'), true);
  assert.equal(sameStock('005930', '삼성전자', '', '삼성전자'), true);
  assert.equal(sameStock('', '애플', '', '엔비디아'), false);
});

test('sameStock: 코드 둘 다 있고 다르면 불일치(이름 같아도)', () => {
  assert.equal(sameStock('005930', '대박', '000660', '대박'), false);
});
