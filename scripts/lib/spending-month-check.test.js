import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  planMonthCheck, findClosedMonthExport, runMonthReport, renderMonthCheck, gapQuestions, previousMonth,
  monthReportPath, missingInstruments,
} from './spending-month-check.mjs';

const root = mkdtempSync(join(tmpdir(), 'spending-month-check-'));
after(() => rmSync(root, { recursive: true, force: true }));
const banksalad = join(root, '95_Etna', 'Spending', 'Banksalad');
const addExport = (name) => {
  mkdirSync(join(banksalad, name), { recursive: true });
  writeFileSync(join(banksalad, name, 'source.xlsx'), '');
};

test('지난달 계산은 해를 넘긴다', () => {
  assert.equal(previousMonth('2026-11-01'), '2026-10');
  assert.equal(previousMonth('2027-01-15'), '2026-12');
});

test('점검 계획: 첫 점검 달 이전·대기·준비·이미 끝남', () => {
  assert.deepEqual(planMonthCheck({ date: '2026-10-30', root }), { status: 'none', month: '2026-09' });
  assert.deepEqual(planMonthCheck({ date: '2026-11-01', root }), { status: 'waiting', month: '2026-10' });
  // 말일 당일에 끝나는 내보내기는 그날 저녁 거래가 빠질 수 있어 닫힌 달로 쓰지 않는다.
  addExport('2025-11-01_2026-10-31');
  assert.equal(planMonthCheck({ date: '2026-11-01', root }).status, 'waiting');
  // source.xlsx가 없는 폴더는 내보내기가 아니다.
  mkdirSync(join(banksalad, '2025-11-01_2026-11-03'), { recursive: true });
  assert.equal(findClosedMonthExport('2026-10', root), null);
  addExport('2025-11-02_2026-11-02');
  addExport('2025-11-01_2026-11-01');
  assert.equal(findClosedMonthExport('2026-10', root), '2025-11-02_2026-11-02');
  assert.deepEqual(planMonthCheck({ date: '2026-11-02', root }), { status: 'ready', month: '2026-10', exportName: '2025-11-02_2026-11-02' });
  mkdirSync(join(root, '95_Etna', 'Spending', 'Monthly'), { recursive: true });
  writeFileSync(monthReportPath('2026-10', root), '{}');
  assert.equal(planMonthCheck({ date: '2026-11-02', root }).status, 'none');
});

test('python 실패는 마지막 오류 줄과 함께 던지고, 성공하면 임시 출력만 읽는다', () => {
  const failing = () => ({ status: 2, stderr: 'usage...\nspending_month.py: error: No Banksalad export covers' });
  assert.throws(() => runMonthReport('2026-10', { root, spawn: failing }), /No Banksalad export covers/);
  let seenArgs;
  const ok = (python, args) => {
    seenArgs = args;
    writeFileSync(args[args.indexOf('--output') + 1], JSON.stringify({ period: { closed_month: '2026-10' } }));
    return { status: 0, stderr: '' };
  };
  const { report, text } = runMonthReport('2026-10', { root, spawn: ok });
  assert.equal(report.period.closed_month, '2026-10');
  assert.match(text, /closed_month/);
  assert.ok(!seenArgs[seenArgs.indexOf('--output') + 1].startsWith(root), '볼트가 아닌 임시 경로에 쓴다');
  assert.ok(!seenArgs.includes('--events-dir'), '아르고스 폴더가 없으면 넘기지 않는다');
});

const report = {
  period: { start: '2026-10-01', end: '2026-10-31', closed_month: '2026-10' },
  source: { export: '2025-11-02_2026-11-02' },
  monthly: { total_expense: '3000000', everyday_expense: '2500000', one_off_tax: '0', confirmed_prepayment: '300000',
    unverified_usage_spending: '200000', total_expense_offset: '50000', net_expense: '2950000', total_income: '6000000' },
  coverage: { transactions: 100, parsed: 40, raw_unparsed: 5, no_alert: 45, no_source: 10, parsed_delayed: 2 },
  missed: [
    ...Array.from({ length: 4 }, () => ({ payment_instrument: 'K-패스 체크', signed_amount: '-1500', alert_coverage: 'no_alert', description: '교통' })),
    { payment_instrument: '아주아주긴이름의지역화폐체크카드결제수단', signed_amount: '-12345678', alert_coverage: 'no_alert', description: 'x' },
    { payment_instrument: '새마을금고 월급통장', signed_amount: '6227630', alert_coverage: 'no_alert', description: '전자급여' },
    { payment_instrument: '네이버페이 간편결제', signed_amount: '-1900', alert_coverage: 'raw_unparsed', description: '컬리<멤버스>', alert_raw_sources: ['kakao-app:PAYCO'] },
    ...Array.from({ length: 3 }, () => ({ payment_instrument: null, signed_amount: '-100', alert_coverage: 'no_alert', description: '줄\n바뀜' })),
  ],
  alert_only: [{ at: '2026-10-05T12:00:00+09:00', amount: '7000', card: '삼성', merchant: 'A&B' }],
};
const places = { month: '2026-10', recordedDays: 3, firstDay: '2026-10-29',
  places: [{ place: '송도 센트럴파크 근처 아주 긴 이름의 가게', days: 2, count: 3, amount: 45000 }, { place: '집', days: 3, count: 4, amount: 30000 }],
  moveAmount: 6000, noneAmount: 1000 };

test('월간 점검 본문: 합계·커버리지·빈칸 표·파서 후보·장소별, 표는 폰 한 줄 안', () => {
  const body = renderMonthCheck(report, { previous: { monthly: { total_expense: '2800000' }, coverage: { transactions: 50, parsed: 10, no_source: 0 } }, places });
  assert.match(body, /^2026-10 지출 마감 \(내보내기 2025-11-02_2026-11-02\)/);
  assert.match(body, /- 전체 지출 3,000,000원\n- 생활비 2,500,000원\n- 선납 300,000원\n- 사용처 미확인 출금 200,000원/);
  assert.doesNotMatch(body, /세금/);
  assert.match(body, /환불·정산 차감 50,000원 → 순지출 2,950,000원/);
  assert.match(body, /지난달 대비 전체 지출 \+200,000원/);
  assert.match(body, /거래 100건: 잡힘 40 · 못 읽음 5 · 알림 없음 45/);
  assert.match(body, /알림 수집이 없던 날 거래 10건/);
  assert.match(body, /잡힘 비율 44% \(지난달 20%\)/);
  assert.match(body, /K-패스 체크 +4 +6,000/);
  assert.doesNotMatch(body, /월급통장/, '들어온 돈은 빈칸 표에 넣지 않는다');
  assert.match(body, /컬리&lt;멤버스&gt; 1,900원 \(kakao-app:PAYCO\)/);
  assert.match(body, /10-05 A&amp;B 7,000원/);
  assert.match(body, /기록 3일\(2026-10-29부터\) · 이동 중 6,000원 · 위치 없음 1,000원/);
  for (const block of body.match(/<pre>[\s\S]*?<\/pre>/g)) {
    for (const line of block.replace(/<\/?pre>/g, '').replace(/&amp;/g, '&').split('\n')) {
      const width = [...line].reduce((sum, char) => sum + (/[ᄀ-ᅟ⺀-꓏가-힣]/.test(char) ? 2 : 1), 0);
      assert.ok(width <= 44, `표 한 줄 ${width}칸: ${line}`);
    }
  }
  assert.match(body, /~/, '긴 이름은 잘린다');
  assert.doesNotMatch(body, /null/);
  assert.match(body, /\(없음\) +3 +300/);
});

test('지난달 결과가 없으면 비교 줄을 빼고, 장소 기록이 없으면 그렇게 쓴다', () => {
  const body = renderMonthCheck(report, { places: { recordedDays: 0 } });
  assert.doesNotMatch(body, /지난달/);
  assert.match(body, /■ 장소별 소비\n- 기록 없음/);
  assert.throws(() => renderMonthCheck({ ...report, monthly: null }), /닫힌 달/);
  assert.match(renderMonthCheck(report, { places: { failed: true } }), /■ 장소별 소비\n- 읽기 실패/);
});

test('빈칸 질문은 문턱 이상인 결제수단만, 달이 바뀌어도 같은 문구·키', () => {
  assert.deepEqual(missingInstruments(report).map((group) => [group.instrument, group.count]),
    [['K-패스 체크', 4], ['(없음)', 3], ['아주아주긴이름의지역화폐체크카드결제수단', 1]]);
  const questions = gapQuestions(report);
  assert.equal(questions.length, 1, '결제수단이 비어 있는 거래는 묻지 않는다');
  assert.equal(questions[0].dedupeKey, 'spending-alert-gap:K-패스 체크');
  assert.equal(questions[0].urgent, false);
  assert.equal(questions[0].kind, 'manual-change');
  const nextMonth = gapQuestions({ ...report, missed: [...report.missed, ...report.missed] });
  assert.equal(nextMonth[0].question, questions[0].question);
});
