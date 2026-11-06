import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerFaq, displayWidth, FAQ_LINE_WIDTH, parseFaq, resolveRange } from './telegram-gate-faq.mjs';
import { routeUpdate } from './telegram-gate-router.mjs';

// 가짜 볼트(실제 금액·종목 아님).
const NOW = new Date('2026-11-06T03:00:00Z'); // KST 11-06(금) 12:00
const read = {
  calendarDay: (date) => ({
    '2026-11-07': { events: [{ allDay: true, title: '가족 나들이', person: '가족' }, { start: '2026-11-07T05:00:00Z', end: '2026-11-07T06:00:00Z', title: '<치과>', person: '나' }] },
    '2026-11-08': { events: [] },
  })[date] ?? null,
  executions: () => [
    { tradeDate: '2026-11-06 10:01:00', tradeType: '매수', account: '위탁', stockName: '시험종목가나다라마바사아자차카타파하', quantity: 3, price: 12345, currency: 'KRW' },
    { tradeDate: '2026-11-06 09:00:00', tradeType: '매도', account: 'ISA', stockName: 'TEST ETF', quantity: 10, price: 1000, currency: 'KRW' },
    { tradeDate: '2026-11-05 09:00:00', tradeType: '매수', account: 'ISA', stockName: '어제종목', quantity: 1, price: 1, currency: 'KRW' },
  ],
  holdings: () => [
    { account: '위탁', name: '예수금', isCashLike: true, evalAmount: 1000, anchorTs: '2026-11-06' },
    { account: '위탁', name: '시험A', isCashLike: false, evalAmount: 5000 },
    { account: 'ISA', name: '시험B', isCashLike: false, evalAmount: 2000 },
  ],
  spendingSummary: (date) => (date === '2026-11-06' ? { hasSource: true, total: 3000, expenseCount: 2, byCategory: { 일반: 2000, 교통비: 1000 },
    entries: [{ status: 'expense', merchant: '시험 가게', amount: 2000 }, { status: 'expense', merchant: '버스', amount: 1000, category: '교통비' }] }
    : date === '2026-11-01' ? { hasSource: true, total: 500, expenseCount: 1, byCategory: { 일반: 500 }, entries: [] } : null),
};

test('자주 묻는 질문: 정해진 문장 모양만 받는다(담당 이름 머리 허용, 그 담당 질문일 때만)', () => {
  const yes = [
    ['이번 주말 일정 뭐야?', 'calendar', 'hermes'], ['주말 내 일정 어떤게 있지?', 'calendar', 'hermes'], ['오늘 일정', 'calendar', 'hermes'],
    ['내일 가족 일정 알려줘', 'calendar', 'hermes'], ['11월 14일 일정은?', 'calendar', 'hermes'], ['11/14 일정', 'calendar', 'hermes'],
    ['헤르메스 이번 주말 일정 뭐야', 'calendar', 'hermes'], ['다음 주 일정', 'calendar', 'hermes'],
    ['플루토스 오늘 체결 내역 정리해줘', 'trades', 'plutus'], ['오늘 체결 알려줘', 'trades', 'plutus'],
    ['예수금 얼마야?', 'cash', 'plutus'], ['보유 현황 보여줘', 'holdings', 'plutus'], ['내 보유 종목', 'holdings', 'plutus'],
    ['오늘 소비', 'spending', 'hermes'], ['이번 달 지출 얼마야', 'spending', 'hermes'],
  ];
  for (const [text, kind, agent] of yes) {
    const q = parseFaq(text);
    assert.ok(q, text);
    assert.equal(q.kind, kind, text);
    assert.equal(q.agent, agent, text);
  }
});

test('자주 묻는 질문 오탐 방지: 덧붙인 말·조건·판단·비교·다른 담당 이름·없는 날짜는 대화로', () => {
  for (const text of [
    '11월 14일 가족 중 일정이 등록된 사람이 누구야?', '이번 주말 일정 뭐야 그리고 날씨는?', '이번 주말 일정 잡아줘', '내일 일정 추가해줘 3시 치과',
    '이번 주말 일정 비어 있으면 미네랑 놀러 갈까?', '일정', '주말에 뭐 하지', '오늘 체결 내역이랑 예수금 비교해줘', '오늘 체결 안 된 주문 있어?',
    '어제 체결 알려줘', 'IRP 예수금 확인해 줘. 수동 반영 요청했어', '예수금 넣어줘', '보유 종목 팔까?', '오늘 소비 줄이려면?',
    '플루토스 이번 주말 일정 뭐야', '헤르메스 오늘 체결 알려줘', '아테나 오늘 일정', '2월 30일 일정', '13월 1일 일정',
    '미네 오늘 학원 몇 시에 끝나지?', '이번 달 소비 패턴 분석해줘', '보유', '예수금 일정',
  ]) assert.equal(parseFaq(text), null, text);
});

test('날짜 말 → 범위(KST): 이번 주말은 다가오는 토·일, 일요일이면 그날, 다음 주는 월~일', () => {
  assert.deepEqual(resolveRange('이번 주말', '2026-11-06'), ['2026-11-07', '2026-11-08']);
  assert.deepEqual(resolveRange('주말', '2026-11-07'), ['2026-11-07', '2026-11-08']);
  assert.deepEqual(resolveRange('주말', '2026-11-08'), ['2026-11-08', '2026-11-08']);
  assert.deepEqual(resolveRange('이번 주', '2026-11-06'), ['2026-11-06', '2026-11-08']);
  assert.deepEqual(resolveRange('다음 주', '2026-11-06'), ['2026-11-09', '2026-11-15']);
  assert.deepEqual(resolveRange('다음 주', '2026-11-08'), ['2026-11-09', '2026-11-15']);
  assert.deepEqual(resolveRange('내일', '2026-12-31'), ['2027-01-01', '2027-01-01']);
  assert.deepEqual(resolveRange({ month: 11, day: 14 }, '2026-11-06'), ['2026-11-14', '2026-11-14']);
});

test('일정 답: 날짜별 ■, 사람 표시, 파일 없음·일정 없음 구분, HTML 이스케이프, 헤르메스 이름표', () => {
  const a = answerFaq(parseFaq('이번 주말 일정 뭐야?'), { now: NOW, read });
  assert.equal(a.agent, 'hermes');
  assert.match(a.body, /■ 11-07\(토\)\n- 종일 \[가족\] 가족 나들이\n- 14:00~15:00 \[나\] &lt;치과&gt;/);
  assert.match(a.body, /■ 11-08\(일\)\n- 일정 없음/);
  assert.match(answerFaq(parseFaq('11월 20일 일정'), { now: NOW, read }).body, /일정 파일 없음/);
});

test('체결·예수금·보유·소비 답: 오늘 것만, 표는 44칸 안(숫자 앞·이름 끝), 데이터 없으면 없다고', () => {
  const widthOk = (body) => {
    const inner = body.match(/<pre>([\s\S]*?)<\/pre>/)?.[1] ?? '';
    for (const line of inner.split('\n')) assert.ok(displayWidth(line.replace(/&amp;/g, '&')) <= FAQ_LINE_WIDTH, `${line} (${displayWidth(line)})`);
  };
  const trades = answerFaq(parseFaq('오늘 체결'), { now: NOW, read });
  assert.equal(trades.agent, 'plutus');
  assert.match(trades.body, /체결 2건/);
  assert.match(trades.body, /-10 +1,000 ISA TEST ETF/);
  assert.doesNotMatch(trades.body, /어제종목/);
  assert.ok(trades.body.indexOf('ISA') < trades.body.indexOf('위탁'), '시각 순');
  widthOk(trades.body);
  const none = answerFaq(parseFaq('오늘 체결'), { now: NOW, read: { ...read, executions: () => [] } });
  assert.match(none.body, /체결 기록이 없습니다/);
  const cash = answerFaq(parseFaq('예수금'), { now: NOW, read });
  assert.match(cash.body, /1,000 위탁 11-06/);
  widthOk(cash.body);
  const holdings = answerFaq(parseFaq('보유 요약'), { now: NOW, read });
  assert.match(holdings.body, /6,000 +1 위탁/);
  assert.match(holdings.body, /8,000 +합계/);
  widthOk(holdings.body);
  const today = answerFaq(parseFaq('오늘 소비'), { now: NOW, read });
  assert.equal(today.agent, 'hermes');
  assert.match(today.body, /확인된 지출 3,000원 \(2건\)/);
  const month = answerFaq(parseFaq('이번 달 소비'), { now: NOW, read });
  assert.match(month.body, /확인된 지출 3,500원\(3건\)/);
  assert.match(month.body, /알림 기록이 없는 날 4일/);
  widthOk(month.body);
});

test('라우터: 자주 묻는 질문은 faq(결정론), 근접 문장은 대화', () => {
  const route = (text) => routeUpdate({ message: { message_id: 1, date: 0, chat: { id: 1, type: 'private' }, from: { id: 1 }, text } }, { allowFrom: new Set(['1']) });
  assert.equal(route('이번 주말 일정 뭐야?').route, 'faq');
  assert.equal(route('플루토스 오늘 체결 내역 정리해줘').route, 'faq');
  assert.equal(route('11월 14일 가족 중 일정이 등록된 사람이 누구야?').route, 'llm');
  assert.equal(route('헤르메스 내가 최근 언제 미용실을 방문했지?').route, 'llm');
});

test('재료 미리 붙이기: 날짜+일정 낱말이면 일정, 체결·예수금·보유·소비(오늘·이번 달) 낱말이면 그 사실, 없으면 null', async () => {
  const { prefetchFacts, prefetchPlan } = await import('./telegram-gate-faq.mjs');
  assert.deepEqual(prefetchPlan('11월 14일 가족 중 일정이 등록된 사람이 누구야?'), [{ kind: 'calendar', range: { month: 11, day: 14 } }]);
  assert.deepEqual(prefetchPlan('이번 주말 일정 비어 있으면 미네랑 놀러 갈까?'), [{ kind: 'calendar', range: '이번 주말' }]);
  assert.deepEqual(prefetchPlan('IRP 예수금은 대금이 빠져나가는데 체결일이 오늘이야').map((p) => p.kind), ['trades', 'cash']);
  assert.deepEqual(prefetchPlan('이번 달 소비 패턴 분석해줘'), [{ kind: 'spending', scope: 'month' }]);
  assert.deepEqual(prefetchPlan('내일 공원 산책 옷차림'), []);
  assert.deepEqual(prefetchPlan('2월 30일 일정 잡아줘'), []);
  const facts = prefetchFacts('이번 주말 일정 비어 있으면 놀러 갈까', { now: NOW, read });
  assert.match(facts, /^· 일정\n■ 11-07\(토\)\n- 종일 \[가족\] 가족 나들이\n- 14:00~15:00 \[나\] <치과>/, 'HTML을 벗긴 평문');
  assert.equal(prefetchFacts('안녕', { now: NOW, read }), null);
  assert.equal(prefetchFacts('오늘 체결', { now: NOW, read: { ...read, executions: () => { throw new Error('x'); } } }), null, '읽기 실패는 붙이지 않는다');
});
