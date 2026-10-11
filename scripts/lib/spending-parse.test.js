import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpendingRecord, parseSpendingRecords } from './spending-parse.mjs';

const base = { ts: '2026-10-10 12:34:00', packageName: 'fake.card', sender: '', body: '' };

test('삼성·하나 알림톡, 하나 앱, 카카오페이 송금의 확인된 필드만 파싱한다', () => {
  const samsung = parseSpendingRecord({ ...base, body: '삼성1234승인\n12,300원 일시불\n10/10 12:34 가상식당\n누적 50,000원' });
  assert.deepEqual([samsung.card, samsung.amount, samsung.merchant], ['삼성', 12300, '가상식당']);
  const hanaTalk = parseSpendingRecord({ ...base, sender: '하나카드', body: '◆ 사용금액 : 31,000원\n가맹점 : 가상식당' });
  assert.deepEqual([hanaTalk.card, hanaTalk.amount, hanaTalk.merchant], ['하나', 31000, '가상식당']);
  const hanaApp = parseSpendingRecord({ ...base, packageName: '하나카드', sender: '(결제) 31,000원', body: '가상식당 / 신용(일시불, 10.10 12:34)' });
  assert.deepEqual([hanaApp.card, hanaApp.amount, hanaApp.merchant], ['하나', 31000, '가상식당']);
  const transfer = parseSpendingRecord({ ...base, packageName: '카카오페이', body: '가상 계좌로 8,000원을 송금했어요' });
  assert.deepEqual([transfer.card, transfer.amount, transfer.merchant], ['카카오페이', 8000, null]);
  assert.equal(parseSpendingRecord({ ...base, body: '승인 31,000원' }), null);
});

test('같은 카드사·금액의 3분 이내 알림은 가맹점 있는 쪽으로 합친다', () => {
  const notifications = [
    { ...base, sender: '하나카드', body: '◆ 사용금액 : 31,000원' },
    { ...base, ts: '2026-10-10 12:35:00', packageName: '하나카드', sender: '(결제) 31,000원', body: '가상식당 / 신용(일시불, 10.10 12:35)' },
  ];
  const parsed = parseSpendingRecords(notifications);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].merchant, '가상식당');
});

test('실제 형식 회귀: 하나 알림톡 "가맹점명"과 하나카드 앱 패키지 이름(hanaskcard)', () => {
  const talk = parseSpendingRecord({ ...base, packageName: 'com.kakao.talk', sender: '하나카드',
    body: '[하나카드] 승인 안내\n\n◆ 사용금액 : 31,000원 \n◆ 이용현황\n    - 거래종류 : 신용\n    - 가맹점명 : 가상식당\n    - 거래시간 : 10/10 12:34 ' });
  assert.deepEqual([talk.card, talk.amount, talk.merchant], ['하나', 31000, '가상식당']);
  const app = parseSpendingRecord({ ...base, packageName: 'com.hanaskcard.example', sender: '(결제) 31,000원',
    body: '가상식당 / 신용(일시불,0*0*) / 10.10 12:34 / 누적이용금액 1원' });
  assert.deepEqual([app.card, app.amount, app.merchant], ['하나', 31000, '가상식당']);
});
