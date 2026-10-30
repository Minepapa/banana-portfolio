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
  assert.deepEqual([transfer.card, transfer.amount, transfer.merchant, transfer.status], ['카카오페이', 8000, null, 'pending']);
  assert.equal(parseSpendingRecord({ ...base, body: '승인 31,000원' }), null);
});

test('카카오페이 앱 송금은 수취 계좌를 보존하되 본인 계좌 설정 전에는 합산하지 않는다', () => {
  const transfer = { ...base, packageName: 'com.kakaopay.app', sender: '송금이 완료되었어요',
    body: '가상은행 1234 (가*상)계좌로 8,000원 송금했어요.\n받는 분 : 가상' };
  const pending = parseSpendingRecord(transfer);
  assert.deepEqual([pending.status, pending.recipientBank, pending.recipientLast4], ['pending', '가상은행', '1234']);
  assert.equal(parseSpendingRecord(transfer, { ownAccounts: [{ bank: '가상은행', last4: '1234' }] }).status, 'excluded');
  assert.equal(parseSpendingRecord({ ...transfer, sender: '송금을 받아주세요' }), null);
  const talk = { ...transfer, packageName: 'com.kakao.talk', sender: '카카오페이' };
  const merged = parseSpendingRecords([talk, transfer]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].source, 'com.kakaopay.app');
  assert.equal(parseSpendingRecords([transfer, { ...transfer,
    body: transfer.body.replace('가상은행', '예시은행') }]).length, 2);
});

test('확정 송금의 중복 알림을 합쳐도 계좌이체 분류를 보존한다', () => {
  const transfer = { ...base, packageName: 'com.kakaopay.app', sender: '송금이 완료되었어요',
    body: '가상은행 1111 (가*상)계좌로 8,000원 송금했어요.' };
  const talk = { ...transfer, packageName: 'com.kakao.talk', sender: '카카오페이' };
  const [merged] = parseSpendingRecords([talk, transfer], {
    recipientDecisions: [{ bank: '가상은행', last4: '1111', status: 'expense' }],
  });
  assert.equal(merged.category, '계좌이체');
});

test('설정에서 확인된 휘영 수취처는 제외하고 명시적인 지출 판정만 예외로 허용한다', () => {
  const transfer = { ...base, packageName: 'com.kakaopay.app', sender: '송금이 완료되었어요',
    body: '가상은행 2468 (휘*영)계좌로 8,000원 송금했어요.' };
  const excluded = parseSpendingRecord(transfer, { recipientDecisions: [
    { bank: '가상은행', last4: '2468', recipient: '휘영' },
  ] });
  assert.deepEqual([excluded.status, excluded.category, excluded.recipient], ['excluded', '계좌이체', '휘영']);
  const expense = parseSpendingRecord(transfer, { recipientDecisions: [
    { bank: '가상은행', last4: '2468', recipient: '휘영', status: 'expense' },
  ] });
  assert.deepEqual([expense.status, expense.category, expense.recipient], ['expense', '계좌이체', '휘영']);
  const own = parseSpendingRecord(transfer, { ownAccounts: [{ bank: '가상은행', last4: '2468' }],
    recipientDecisions: [{ bank: '가상은행', last4: '2468', recipient: '휘영', status: 'expense' }] });
  assert.deepEqual([own.status, own.recipient], ['excluded', null]);
});

test('2468 알림에 휘영 이름이 있어도 일치하는 설정이 없으면 판정 대기다', () => {
  const transfer = { ...base, packageName: 'com.kakaopay.app', sender: '송금이 완료되었어요',
    body: '가상은행 2468 (휘*영)계좌로 8,000원 송금했어요.\n받는 분 : 휘영' };
  const unrelatedDecision = { bank: '가상은행', last4: '9999', recipient: '휘영' };
  for (const options of [{}, { recipientDecisions: [unrelatedDecision] }]) {
    const parsed = parseSpendingRecord(transfer, options);
    assert.deepEqual([parsed.status, parsed.recipient], ['pending', null]);
  }
});

test('미네 계좌는 명시된 수취인 설정으로만 식별하고 임의의 알림 문구로 추정하지 않는다', () => {
  const transfer = { ...base, packageName: 'com.kakaopay.app', sender: '송금이 완료되었어요',
    body: '가상은행 9876 (미*네)계좌로 8,000원 송금했어요.\n받는 분 : 미네' };
  const pending = parseSpendingRecord(transfer);
  assert.deepEqual([pending.status, pending.category, pending.recipient], ['pending', '계좌이체', null]);
  const mine = parseSpendingRecord(transfer, { recipientDecisions: [
    { bank: '가상은행', last4: '9876', recipient: '미네' },
  ] });
  assert.deepEqual([mine.status, mine.category, mine.recipient], ['excluded', '계좌이체', '미네']);
  const exception = parseSpendingRecord(transfer, { recipientDecisions: [
    { bank: '가상은행', last4: '9876', recipient: '미네', status: 'expense' },
  ] });
  assert.deepEqual([exception.status, exception.recipient], ['expense', '미네']);
});

test('끝4가 다른 동액 승인과 취소는 지출로 합치지 않는다', () => {
  const first = { ...base, packageName: 'com.hanaskcard.paycla', sender: '(결제) 31,000원',
    body: '가상식당 / 신용(일시불,1*2*) / 10.10 12:34 / 누적이용금액 1원' };
  const second = { ...first, body: first.body.replace('1*2*', '3*4*') };
  assert.equal(parseSpendingRecords([first, second]).length, 2);
  assert.equal(parseSpendingRecord({ ...first, sender: '(취소) 31,000원' }), null);
});

test('온누리 승인과 교통비를 분류하고 결제대금은 제외한다', () => {
  const onnuri = parseSpendingRecord({ ...base, packageName: 'com.hanaskcard.paycla', sender: '결제',
    body: '온누리(1*2*)가*상 10/10 12:34/일시불/승인/5,000원/가상식당' });
  assert.deepEqual([onnuri.category, onnuri.amount], ['온누리상품권', 5000]);
  const fare = parseSpendingRecord({ ...base, sender: '하나카드', body: '사용금액 : 1,500원\n가맹점 : 버스 교통비' });
  assert.equal(fare.category, '교통비');
  assert.equal(parseSpendingRecord({ ...base, sender: '하나카드', body: '온누리 결제대금 5,000원' }), null);
});

test('가맹점 이름의 온누리·취소는 상품권이나 승인취소가 아니다', () => {
  const ordinary = parseSpendingRecord({ ...base, sender: '하나카드',
    body: '◆ 사용금액 : 5,000원\n가맹점 : 온누리취소식당' });
  assert.deepEqual([ordinary.status, ordinary.category, ordinary.merchant],
    ['expense', '일반', '온누리취소식당']);
  const cancelled = parseSpendingRecord({ ...base, sender: '하나카드',
    body: '◆ 사용금액 : 5,000원\n취소 : 승인취소\n가맹점 : 온누리취소식당' });
  assert.equal(cancelled, null);
  for (const marker of ['[승인취소]', '(광고)', '거래종류 : 취소', '    - 거래종류 : 취소']) {
    assert.equal(parseSpendingRecord({ ...base, sender: '하나카드',
      body: `◆ 사용금액 : 5,000원\n${marker}\n가맹점 : 가상식당` }), null);
  }
});

test('같은 금액·가맹점이어도 온누리와 일반 승인은 별개로 센다', () => {
  const general = { ...base, ts: '2026-10-10 12:35:00', sender: '하나카드',
    packageName: 'com.kakao.talk', body: '◆ 사용금액 : 5,000원\n가맹점 : 가상식당' };
  const onnuri = { ...base, packageName: 'com.hanaskcard.paycla', sender: '결제',
    body: '온누리(1*2*)가*상 10/10 12:34/일시불/승인/5,000원/가상식당' };
  const entries = parseSpendingRecords([general, onnuri]);
  assert.deepEqual(entries.map((entry) => entry.category).sort(), ['온누리상품권', '일반']);
  assert.equal(entries.reduce((sum, entry) => sum + entry.amount, 0), 10000);
});

test('삼성카드 온누리 승인에서 결제대금 미포함은 지출 제외 사유가 아니다', () => {
  const approval = { ...base, packageName: 'com.kakao.talk', sender: '삼성카드',
    body: '[삼성카드]10,100원 승인(온누리상품권 10,100원 사용)\n*결제대금에 미포함' };
  const parsed = parseSpendingRecord(approval);
  assert.deepEqual([parsed.amount, parsed.card, parsed.category, parsed.merchant, parsed.status],
    [10100, '삼성', '온누리상품권', null, 'expense']);
  assert.equal(parseSpendingRecord({ ...approval, sender: '삼성카드 광고' }), null);
  assert.equal(parseSpendingRecord({ ...approval, packageName: 'fake.card' }), null);
  assert.equal(parseSpendingRecord({ ...approval, body: approval.body.replace('10,100원 사용', '9,900원 사용') }), null);
  assert.equal(parseSpendingRecord({ ...approval, body: approval.body.replaceAll('10,100', '1,0,100') }), null);
  assert.equal(parseSpendingRecord({ ...approval, body: approval.body.replace('승인', '취소') }), null);
  assert.equal(parseSpendingRecord({ ...approval, body: `${approval.body}\n광고` }), null);
  assert.equal(parseSpendingRecord({ ...approval, body: '온누리상품권 결제대금 10,100원 안내' }), null);
});

test('하나 앱 통신비 자동납부 정상승인만 지출로 파싱한다', () => {
  const approval = { ...base, packageName: 'com.hanaskcard.paycla',
    sender: '자동납부 요금 정상승인 안내',
    body: '[SK텔레콤(자동납부)] 자동납부 요금 정상승인 안내 12,345원' };
  const parsed = parseSpendingRecord(approval);
  assert.deepEqual([parsed.card, parsed.merchant, parsed.amount, parsed.status],
    ['하나', 'SK텔레콤', 12345, 'expense']);
  assert.equal(parseSpendingRecord({ ...approval,
    body: '[KT(자동납부)] 자동납부 요금 정상승인 안내 9,800원' }).merchant, 'KT');
  for (const [body, merchant, amount] of [
    ['[KT통신요금 자동납부] 자동납부 요금 정상승인 안내 35,590원', 'KT통신요금', 35590],
    ['[KT유선상품 자동납부] 자동납부 요금 정상승인 안내 46,750원', 'KT유선상품', 46750],
  ]) {
    const payment = parseSpendingRecord({ ...approval, body });
    assert.deepEqual([payment.card, payment.merchant, payment.amount, payment.status],
      ['하나', merchant, amount, 'expense']);
    assert.equal(parseSpendingRecord({ ...approval, body: body.replace('정상승인', '취소') }), null);
    assert.equal(parseSpendingRecord({ ...approval, body: body.replace('정상승인', '청구') }), null);
    assert.equal(parseSpendingRecord({ ...approval, body: `${body} 광고` }), null);
  }
  assert.equal(parseSpendingRecord({ ...approval, sender: '자동납부 요금 안내' }), null);
  assert.equal(parseSpendingRecord({ ...approval, packageName: 'com.kakao.talk' }), null);
  assert.equal(parseSpendingRecord({ ...approval,
    body: '[SK텔레콤(자동납부)] 자동납부 요금 청구 안내 12,345원' }), null);
  assert.equal(parseSpendingRecord({ ...approval, body: `${approval.body}\n추가 안내` }), null);
});

test('같은 카드사·금액의 3분 이내 알림은 가맹점 있는 쪽으로 합친다', () => {
  const notifications = [
    { ...base, sender: '하나카드', body: '◆ 사용금액 : 31,000원\n가맹점 : 가상식당' },
    { ...base, ts: '2026-10-10 12:35:00', packageName: '하나카드', sender: '(결제) 31,000원', body: '가상식당 / 신용(일시불, 10.10 12:35)' },
  ];
  const parsed = parseSpendingRecords(notifications);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].merchant, '가상식당');
});

test('서로 다른 출처의 동일 결제는 카드 식별자가 한쪽에만 있어도 합치고 식별자를 보존한다', () => {
  const withCard = { ...base, packageName: 'com.hanaskcard.paycla', sender: '(결제) 5,000원',
    body: '가상식당 / 신용(일시불,1*2*) / 10.10 12:34' };
  const withoutCard = { ...base, ts: '2026-10-10 12:35:00', packageName: 'com.kakao.talk',
    sender: '하나카드', body: '◆ 사용금액 : 5,000원\n가맹점명 : 가상식당' };
  for (const notifications of [[withCard, withoutCard], [withoutCard, withCard]]) {
    const merged = parseSpendingRecords(notifications);
    assert.equal(merged.length, 1);
    assert.deepEqual([merged[0].merchant, merged[0].cardMask], ['가상식당', '1*2*']);
  }
  const secondPurchase = { ...withCard, ts: '2026-10-10 12:35:00',
    body: withCard.body.replace('12:34', '12:35') };
  assert.equal(parseSpendingRecords([withCard, secondPurchase]).length, 2);
});

test('같은 금액의 연속 결제는 앱 1건과 Talk 2건을 한 건으로 뭉치지 않는다', () => {
  const app = { ...base, packageName: 'com.hanaskcard.paycla', sender: '(결제) 5,000원',
    body: '가상식당 / 신용(일시불,1*2*) / 10.10 12:34' };
  const talk = { ...base, ts: '2026-10-10 12:35:00', packageName: 'com.kakao.talk',
    sender: '하나카드', body: '◆ 사용금액 : 5,000원\n가맹점명 : 가상식당' };
  const secondTalk = { ...talk, ts: '2026-10-10 12:36:00' };
  const parsed = parseSpendingRecords([app, talk, secondTalk]);
  assert.equal(parsed.length, 2);
  assert.equal(parsed.reduce((sum, entry) => sum + entry.amount, 0), 10000);
  assert.equal(parsed[0].cardMask, '1*2*');
  assert.equal(parsed[0].merchant, '가상식당');
});

test('알림 순서와 관계없이 온누리 분류와 카드 식별자를 보존한다', () => {
  const talk = { ...base, packageName: 'com.kakao.talk', sender: '하나카드',
    body: '◆ 사용금액 : 5,000원\n가맹점명 : 가상식당\n- 이용카드 : MG+ 하나 1*2*온누리' };
  const app = { ...base, packageName: 'com.hanaskcard.paycla', sender: '결제',
    body: '온누리(1*2*)가*상 10/10 12:34/일시불/승인/5,000원/가상식당' };
  for (const records of [[talk, app], [app, talk]]) {
    const [merged] = parseSpendingRecords(records);
    assert.equal(parseSpendingRecords(records).length, 1);
    assert.deepEqual([merged.category, merged.cardMask, merged.merchant],
      ['온누리상품권', '1*2*', '가상식당']);
  }
});

test('명시적으로 다른 카드 식별자와 다른 가맹점·시간은 별도 결제로 남긴다', () => {
  const app = { ...base, packageName: 'com.hanaskcard.paycla', sender: '(결제) 5,000원',
    body: '가상식당 / 신용(일시불,1*2*) / 10.10 12:34' };
  const talk = { ...base, packageName: 'com.kakao.talk', sender: '하나카드',
    body: '◆ 사용금액 : 5,000원\n가맹점명 : 가상식당' };
  const conflictingMask = { ...talk, body: `${talk.body}\n카드번호 : 3*4*` };
  const conflictingLast4 = { ...talk, body: `${talk.body}\n카드번호 : 1234` };
  const appWithLast4 = { ...app, body: app.body.replace('1*2*', '5678') };
  assert.equal(parseSpendingRecords([app, conflictingMask]).length, 2);
  assert.equal(parseSpendingRecords([appWithLast4, conflictingLast4]).length, 2);
  assert.equal(parseSpendingRecords([app, conflictingLast4]).length, 2);
  assert.equal(parseSpendingRecords([app, { ...talk, body: talk.body.replace('가상식당', '다른식당') }]).length, 2);
  assert.equal(parseSpendingRecords([app, { ...talk, ts: '2026-10-10 12:38:00' }]).length, 2);
});

test('실제 형식 회귀: 하나 알림톡 "가맹점명"과 하나카드 앱 패키지 이름(hanaskcard)', () => {
  const talk = parseSpendingRecord({ ...base, packageName: 'com.kakao.talk', sender: '하나카드',
    body: '[하나카드] 승인 안내\n\n◆ 사용금액 : 31,000원 \n◆ 이용현황\n    - 거래종류 : 신용\n    - 가맹점명 : 가상식당\n    - 거래시간 : 10/10 12:34 ' });
  assert.deepEqual([talk.card, talk.amount, talk.merchant], ['하나', 31000, '가상식당']);
  const app = parseSpendingRecord({ ...base, packageName: 'com.hanaskcard.example', sender: '(결제) 31,000원',
    body: '가상식당 / 신용(일시불,0*0*) / 10.10 12:34 / 누적이용금액 1원' });
  assert.deepEqual([app.card, app.amount, app.merchant], ['하나', 31000, '가상식당']);
});

test('새마을금고 출금은 상대 이름만 남기고 판정 전까지 합계에서 뺀다', () => {
  const withdrawal = { ...base, packageName: 'com.smg.spbs', sender: 'MG새마을금고',
    body: '[출금] 78,360원 1234-5678-****-9 잔액 1,000,000원 10/10 12:30 가상보험１０１２６' };
  const parsed = parseSpendingRecord(withdrawal);
  assert.deepEqual([parsed.card, parsed.amount, parsed.merchant, parsed.status, parsed.category],
    ['새마을금고', 78360, '가상보험10126', 'pending', '계좌이체']);
  assert.ok(!JSON.stringify(parsed).includes('5678'));
  assert.equal(parseSpendingRecord({ ...withdrawal, body: `${withdrawal.body}\n` }).merchant, '가상보험10126');
  assert.equal(parseSpendingRecord({ ...withdrawal, body: withdrawal.body.replace('[출금]', '[입금]') }), null);
});

test('삼성 월렛 결제는 같은 금액·3분 안의 카드 승인이 있으면 한 번만 센다', () => {
  const wallet = { ...base, ts: '2026-10-10 12:35:10', packageName: 'com.samsung.android.spay',
    sender: '₩2,900 결제 완료', body: '가상편의점' };
  const parsed = parseSpendingRecord(wallet);
  assert.deepEqual([parsed.card, parsed.amount, parsed.merchant, parsed.status], ['삼성월렛', 2900, '가상편의점', 'expense']);
  assert.equal(parseSpendingRecord({ ...wallet, sender: '선물하기', body: '쿠폰 선물을 보냈습니다.' }), null);
  const card = { ...base, packageName: 'com.kakao.talk', sender: '삼성카드',
    body: '삼성1234승인\n2,900원 일시불\n10/10 12:34 가상편의점\n누적 50,000원' };
  for (const records of [[wallet, card], [card, wallet]]) {
    const merged = parseSpendingRecords(records);
    assert.deepEqual(merged.map((entry) => entry.card), ['삼성']);
  }
  assert.equal(parseSpendingRecords([wallet]).length, 1);
  assert.equal(parseSpendingRecords([wallet, { ...wallet, ts: '2026-10-10 12:36:10' }, card]).length, 2);
  assert.equal(parseSpendingRecords([{ ...wallet, ts: '2026-10-10 12:40:00' }, card]).length, 2);
  const transfer = { ...base, packageName: 'com.kakaopay.app', sender: '송금이 완료되었어요',
    body: '가상은행 1111 (가*상)계좌로 2,900원 송금했어요.' };
  const withTransfer = parseSpendingRecords([wallet, transfer], {
    recipientDecisions: [{ bank: '가상은행', last4: '1111', status: 'expense' }] });
  assert.deepEqual(withTransfer.map((entry) => entry.card).sort(), ['삼성월렛', '카카오페이']);
});

test('실제 형식 회귀: 카톡 "MG+ 하나 5*8*" 카드 번호와 지점명이 붙은 앱 가맹점을 한 건으로 합친다', () => {
  const talk = { ...base, ts: '2026-10-28 06:38:51', packageName: 'com.kakao.talk', sender: '하나카드',
    body: '[하나카드] 승인 안내\n\n◆ 사용금액 : 30,000원 \n◆ 이용현황\n    - 이용카드 : MG+ 하나 5*8*                    \n    - 거래종류 : 신용\n    - 가맹점명 : 가상주유(주)\n    - 거래시간 : 10/28 06:38 ' };
  const app = { ...base, ts: '2026-10-28 06:38:55', packageName: 'com.hanaskcard.paycla', sender: '(결제) 30,000원',
    body: '가상주유(주)직영송도점 / 신용(일시불,5*8*) / 10.28 06:38 / 누적이용금액 1원' };
  assert.equal(parseSpendingRecord(talk).cardMask, '5*8*');
  for (const records of [[talk, app], [app, talk]]) {
    const merged = parseSpendingRecords(records);
    assert.equal(merged.length, 1);
    assert.deepEqual([merged[0].amount, merged[0].merchant, merged[0].cardMask], [30000, '가상주유(주)직영송도점', '5*8*']);
  }
  // 카드 이름 앞 글자가 있어도 다른 번호면 다른 카드다.
  assert.equal(parseSpendingRecords([app, { ...talk, body: talk.body.replace('5*8*', '3*4*') }]).length, 2);
  // 앞부분 일치는 짧은 쪽이 4자 이상이고 두 알림의 카드 번호가 같을 때만 같은 가게로 본다.
  const withMerchant = (record, from, to) => ({ ...record, body: record.body.replace(from, to) });
  assert.equal(parseSpendingRecords([withMerchant(app, '가상주유(주)직영송도점', '가상주유송도점'),
    withMerchant(talk, '가상주유(주)', '가상주유')]).length, 1);
  assert.equal(parseSpendingRecords([withMerchant(app, '가상주유(주)직영송도점', '가상주송도점'),
    withMerchant(talk, '가상주유(주)', '가상주')]).length, 2);
  const talkWithoutCard = withMerchant(talk, 'MG+ 하나 5*8*', '하나');
  assert.equal(parseSpendingRecord(talkWithoutCard).cardMask, null);
  assert.equal(parseSpendingRecords([app, talkWithoutCard]).length, 2);
  // 카드 이름 안 숫자는 번호가 아니고, 줄 끝 번호만 읽는다.
  const travel = parseSpendingRecord(withMerchant(talk, 'MG+ 하나 5*8*', '트래블로그 2030 5*8*'));
  assert.deepEqual([travel.cardLast4, travel.cardMask], [null, '5*8*']);
  assert.deepEqual([parseSpendingRecord(withMerchant(talk, 'MG+ 하나 5*8*', '트래블로그 2030 하나')).cardLast4,
    parseSpendingRecord(withMerchant(talk, 'MG+ 하나 5*8*', 'MG+ 하나 5*8*온누리')).cardMask], [null, '5*8*']);
  // '이용카드' 줄이 아닌 곳의 네 자리 숫자는 카드 번호로 읽지 않는다.
  assert.equal(parseSpendingRecord({ ...talk, body: talk.body.replace('MG+ 하나 5*8*', 'MG+ 하나').replace('[하나카드] 승인 안내', '[하나카드] 2026 승인 안내') }).cardLast4, null);
});

test('하나 앱 관리비 자동납부 정상승인도 괄호 안 이름을 가맹점으로 파싱한다', () => {
  const approval = { ...base, packageName: 'com.hanaskcard.paycla', sender: '자동납부 요금 정상승인 안내',
    body: '[아파트관리비] 자동납부 요금 정상승인 안내 276,750원' };
  const parsed = parseSpendingRecord(approval);
  assert.deepEqual([parsed.card, parsed.merchant, parsed.amount, parsed.status, parsed.category],
    ['하나', '아파트관리비', 276750, 'expense', '일반']);
  assert.equal(parsed.autopay, true);
  assert.equal('autopay' in parseSpendingRecord({ ...approval, sender: '(결제) 5,000원',
    body: '가상식당 / 신용(일시불,1*2*) / 10.10 12:34' }), false);
  assert.equal(parseSpendingRecord({ ...approval, body: approval.body.replace('정상승인', '청구') }), null);
  assert.equal(parseSpendingRecord({ ...approval, body: '[] 자동납부 요금 정상승인 안내 276,750원' }), null);
  assert.equal(parseSpendingRecord({ ...approval, body: '[아파트\n관리비] 자동납부 요금 정상승인 안내 276,750원' }), null);
  assert.equal(parseSpendingRecord({ ...approval, body: '[하나카드 결제대금] 자동납부 요금 정상승인 안내 276,750원' }), null);
  assert.equal(parseSpendingRecord({ ...approval, body: '[ ] 자동납부 요금 정상승인 안내 276,750원' }), null);
  assert.equal(parseSpendingRecord({ ...approval, body: '[SKT 환불금] 자동납부 요금 정상승인 안내 1,000원' }), null);
});
