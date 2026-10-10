// 원장을 거치지 않는 직접 발송은 호출 수와 사유를 고정해 새 경고의 우회를 드러낸다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOTS = ['jobs', 'tools', 'lib', 'hooks'];
const ALLOWED_RAW_SENDS = Object.freeze({
  'jobs/annual-instrument-rescore.mjs': { count: 2, reason: '재평가 제안 발송 두 경로' },
  'jobs/daily-breakout-signal-scan.mjs': { count: 2, reason: '약세장 중단·신호 없음 완료 안내' },
  'jobs/daily-execution-report.mjs': { count: 1, reason: '체결 내역 정기 보고' },
  'jobs/isa-maturity-check.mjs': { count: 1, reason: '만기 대응 제안' },
  'jobs/monthly-macro-tilt-proposal.mjs': { count: 1, reason: '월간 배분 제안 발송' },
  'jobs/morning-briefing.mjs': { count: 1, reason: '실패가 없는 아침 브리핑' },
  'jobs/new-cash-allocation.mjs': { count: 1, reason: '신규 현금 배분 제안 발송' },
  'jobs/pension-balance-reminder.mjs': { count: 1, reason: '잔고 입력 안내' },
  'jobs/place-breakout-fallback-entry.mjs': { count: 1, reason: '경고 외 폴백 주문 상태 안내' },
  'jobs/proposal-execution-reminder.mjs': { count: 2, reason: '제안 응답·체결 리마인더' },
  'jobs/quarterly-allocation-review.mjs': { count: 1, reason: '분기 배분 검토' },
  'jobs/rebalance-proposal.mjs': { count: 1, reason: '분기 리밸런싱 제안 발송' },
  'jobs/reconcile-breakout-protection.mjs': { count: 1, reason: '경고 외 보호주문 상태 안내' },
  'jobs/themis-risk-review.mjs': { count: 1, reason: '정기 위험 검토 보고' },
  'jobs/weekly-report.mjs': { count: 1, reason: '주간 리포트 요약' },
  'jobs/weekly-schedule-summary.mjs': { count: 1, reason: '주간 일정 안내' },
  'tools/breakout-watchlist-preview.mjs': { count: 1, reason: '워치리스트 미리보기' },
  'tools/create-quant-proposal.mjs': { count: 1, reason: '퀀트 제안 발송' },
  'tools/deploy-android-app.mjs': { count: 1, reason: '앱 배포 완료 알림' },
  'tools/execute-asset-allocation-proposal.mjs': { count: 1, reason: '자산배분 승인 만료 안내' },
  'tools/execute-quant-proposal.mjs': { count: 1, reason: '퀀트 승인 만료 안내' },
  'tools/place-breakout-entry-order.mjs': { count: 4, reason: '진입 보류 세 경로·주문 접수 안내' },
  'tools/process-telegram-reply.mjs': { count: 1, reason: '거부 패턴 재확인 안내' },
  'tools/watch-breakout-entry-fill.mjs': { count: 4, reason: '체결·취소·다음 거래일 전환 상태 안내' },
  'tools/watch-nh-order-fill.mjs': { count: 1, reason: 'NH 주문 체결 확인' },
  'tools/watch-order-fill.mjs': { count: 2, reason: '가격이 확인된 주문 취소·체결 안내' },
  'tools/watch-price-and-propose.mjs': { count: 1, reason: '가격 감시 후 제안 발송' },
});

function* scriptFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* scriptFiles(path);
    else if (entry.name.endsWith('.mjs') && !entry.name.includes('.test.')) yield path;
  }
}

export function countRawSends(path, rawSource) {
  if (path === 'lib/pantheon-send.mjs') return 0; // 전송 함수 정의는 발송 호출이 아니다.
  const ast = parse(rawSource, { ecmaVersion: 'latest', sourceType: 'module' });
  let count = 0;
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CallExpression') {
      const callee = node.callee;
      if ((callee.type === 'Identifier' && callee.name === 'sendAgentMessage')
        || (callee.type === 'MemberExpression'
          && (callee.computed ? callee.property.value === 'sendAgentMessage'
            : callee.property.name === 'sendAgentMessage'))) count++;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(ast);
  return count;
}

test('직접 발송 호출 수는 파일별 허용표와 정확히 일치해야 한다', () => {
  assert.equal(countRawSends('jobs/new-warning.mjs', 'await flushWarnings(); await sendAgentMessage({ body: "실패" })'), 1);
  assert.equal(countRawSends('jobs/new-warning.mjs', '// sendAgentMessage()\nawait sendDirectWarning({ send: sendAgentMessage })'), 0);
  assert.equal(countRawSends('jobs/new-warning.mjs', 'const note = "sendAgentMessage()"; // sendAgentMessage()\nawait io.sendAgentMessage({ body: note });'), 1);

  const actualCounts = new Map();
  for (const root of ROOTS) {
    for (const file of scriptFiles(join(SCRIPTS, root))) {
      const path = relative(SCRIPTS, file).replaceAll('\\', '/');
      const count = countRawSends(path, readFileSync(file, 'utf8'));
      if (count > 0) actualCounts.set(path, count);
    }
  }

  const unknown = [...actualCounts.keys()].filter((path) => !ALLOWED_RAW_SENDS[path]);
  assert.deepEqual(unknown, [], `새 직접 발송 호출처는 사유와 허용 수를 등록하거나 원장을 통과시켜야 함: ${unknown.join(', ')}`);
  for (const [path, { count, reason }] of Object.entries(ALLOWED_RAW_SENDS)) {
    assert.ok(Number.isInteger(count) && count > 0 && reason.trim(), `${path}: 허용 수와 사유 필요`);
    assert.equal(actualCounts.get(path) ?? 0, count,
      `${path}: 직접 발송 수가 달라짐(현재 ${actualCounts.get(path) ?? 0}, 허용 ${count}) — 호출처를 검토하고 허용표 갱신 필요`);
  }
});
