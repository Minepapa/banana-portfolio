import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getYearLabel, shouldRunThisYear, evaluateRescoreCandidate, buildRescorePrompt, isLastWindowRun, yearMarkerHold, isLegSent, isPartialReplacement, normalizeProgress, buildWindowEndFacts, instrumentKey, isWindowEnded, readProgress, legYearState, decideReplacementStep, RESCORE_REASON_TAG } from './annual-instrument-rescore.mjs';
import { createAndSendProposal } from '../lib/proposal-flow.mjs';

test('getYearLabel: YYYY 문자열', () => {
  assert.equal(getYearLabel(new Date(2027, 0, 2)), '2027');
});

test('shouldRunThisYear: 1월 1~3일 평일이고 올해 미실행이면 true', () => {
  // 2027-01-04는 월요일(평일)이 아니라 실제 1~3일 범위 안의 평일을 고른다 — 2026-01-01은 목요일.
  assert.equal(shouldRunThisYear(new Date(2026, 0, 1), '2025'), true);
});

test('shouldRunThisYear: 1월 4일 이후면 false', () => {
  assert.equal(shouldRunThisYear(new Date(2026, 0, 4), '2025'), false);
});

test('shouldRunThisYear: 1월이 아니면 false', () => {
  assert.equal(shouldRunThisYear(new Date(2026, 3, 2), '2025'), false);
});

test('shouldRunThisYear: 주말이면 false', () => {
  // 2028-01-01은 토요일
  assert.equal(shouldRunThisYear(new Date(2028, 0, 1), '2027'), false);
});

test('shouldRunThisYear: 올해 이미 실행됐으면 false', () => {
  assert.equal(shouldRunThisYear(new Date(2026, 0, 1), '2026'), false);
});

function score(name, composite, axes = {}, dataGaps = []) {
  return { name, composite, axes, dataGaps };
}

test('evaluateRescoreCandidate: 격차가 임계값 이상이면 재검토 필요', () => {
  const held = score('A', 50);
  const ranked = [score('B', 65), score('A', 50)];
  const r = evaluateRescoreCandidate(held, ranked, 10);
  assert.equal(r.needsReview, true);
  assert.equal(r.scoreDelta, 15);
  assert.equal(r.bestAlternative.name, 'B');
});

test('evaluateRescoreCandidate: 격차가 임계값 미만이면 재검토 불필요', () => {
  const held = score('A', 50);
  const ranked = [score('B', 55), score('A', 50)];
  const r = evaluateRescoreCandidate(held, ranked, 10);
  assert.equal(r.needsReview, false);
  assert.equal(r.scoreDelta, 5);
});

test('evaluateRescoreCandidate: 보유 종목이 스코어링 불가(composite null)면 비교 자체를 안 함', () => {
  const held = score('A', null);
  const ranked = [score('B', 90)];
  const r = evaluateRescoreCandidate(held, ranked, 10);
  assert.equal(r.needsReview, false);
  assert.match(r.reason, /데이터 부족/);
});

test('evaluateRescoreCandidate: 순위 목록에 자기 자신만 있으면(대안 없음) 재검토 불필요', () => {
  const held = score('A', 50);
  const ranked = [score('A', 50)];
  const r = evaluateRescoreCandidate(held, ranked, 10);
  assert.equal(r.needsReview, false);
  assert.match(r.reason, /대안 없음/);
});

test('evaluateRescoreCandidate: 순위 목록의 최상위가 자기 자신이면 그 다음 대안과 비교', () => {
  const held = score('A', 50);
  const ranked = [score('A', 90), score('B', 65)]; // A가 1위지만 그건 held 본인 — B와 비교해야 함
  const r = evaluateRescoreCandidate(held, ranked, 10);
  assert.equal(r.bestAlternative.name, 'B');
  assert.equal(r.scoreDelta, 15);
});

test('evaluateRescoreCandidate: 대안 후보 중 composite null인 항목은 건너뛰고 다음 유효 후보와 비교', () => {
  const held = score('A', 50);
  const ranked = [score('B', null), score('C', 70)];
  const r = evaluateRescoreCandidate(held, ranked, 10);
  assert.equal(r.bestAlternative.name, 'C');
});

test('evaluateRescoreCandidate: 보유·대안의 데이터 부족축 구성이 다르면 공정비교 불가로 재검토 안 함(2026-09-06 코드리뷰 지적 — 다른 축 개수로 계산된 점수를 직접 빼면 안 됨)', () => {
  const held = score('A', 50, {}, ['expenseRatio']); // 보유는 보수율 데이터 없음(3축 점수)
  const ranked = [score('B', 90, {}, [])]; // 대안은 4축 전부 있음
  const r = evaluateRescoreCandidate(held, ranked, 10);
  assert.equal(r.needsReview, false);
  assert.match(r.reason, /축 구성 불일치/);
});

test('evaluateRescoreCandidate: 데이터 부족축 구성이 같으면(둘 다 완전하거나 둘 다 같은 축 결측) 정상 비교', () => {
  const held = score('A', 50, {}, ['trackingError']);
  const ranked = [score('B', 90, {}, ['trackingError'])]; // 같은 축이 둘 다 결측 — 공정 비교 가능
  const r = evaluateRescoreCandidate(held, ranked, 10);
  assert.equal(r.needsReview, true);
  assert.equal(r.scoreDelta, 40);
});

test('buildRescorePrompt: 위탁 계좌는 세금·회전비용 고려 문구, 연금저축은 계좌 내 교체 문구', () => {
  const heldScore = score('A', 50, { expenseRatio: 40 }, ['trackingError']);
  const bestAlternative = score('B', 65, { expenseRatio: 90 });
  const wtPrompt = buildRescorePrompt({ account: '위탁', assetClass: '국내주식', heldScore, bestAlternative, scoreDelta: 15 });
  assert.match(wtPrompt, /양도소득세/);
  const pensionPrompt = buildRescorePrompt({ account: '연금저축', assetClass: '국내주식', heldScore, bestAlternative, scoreDelta: 15 });
  assert.match(pensionPrompt, /계좌 내 교체/);
  assert.doesNotMatch(pensionPrompt, /양도소득세/);
});

test('buildRescorePrompt: 데이터 부족축·점수·JSON 출력 계약이 전부 포함', () => {
  const heldScore = score('A', 50, { expenseRatio: 40 }, ['trackingError']);
  const bestAlternative = score('B', 65, { expenseRatio: 90 });
  const prompt = buildRescorePrompt({ account: '위탁', assetClass: '국내주식', heldScore, bestAlternative, scoreDelta: 15 });
  assert.match(prompt, /데이터 부족축: trackingError/);
  assert.match(prompt, /15\.0점/);
  assert.match(prompt, /"verdict":"유지 또는 교체"/);
});

// 2026-10-31 오너 결정 안 2: 판단 실패가 있으면 연 마커를 넘기지 않고, 창이 끝날 때까지 남으면 한 번 알린다.
test('yearMarkerHold: 판단 실패가 전부든 일부든 마커 미전진, 전부 성공이면 전진(null)', () => {
  const base = { hadLimitError: false, hadPartialFailure: false };
  assert.match(yearMarkerHold({ ...base, judgmentFailureCount: 3 }), /판단 실패/, '전부 실패');
  assert.match(yearMarkerHold({ ...base, judgmentFailureCount: 1 }), /판단 실패/, '일부 실패');
  assert.equal(yearMarkerHold({ ...base, judgmentFailureCount: 0 }), null, '전부 성공·재검토 대상 없음');
  assert.match(yearMarkerHold({ hadLimitError: true, hadPartialFailure: false, judgmentFailureCount: 0 }), /사용량 한도/, '기존 한도 보류 유지');
  assert.match(yearMarkerHold({ hadLimitError: false, hadPartialFailure: true, judgmentFailureCount: 0 }), /반쪽 발송/, '기존 반쪽 발송 보류 유지');
});

test('isLastWindowRun: 창(1월 1~3일 평일) 안에서 뒤로 평일이 더 없는 날만 true(KST)', () => {
  const kst = (d) => new Date(`${d}T10:00:00+09:00`);
  // 2026: 1일 목·2일 금·3일 토 → 마지막 실행은 2일
  assert.equal(isLastWindowRun(kst('2026-01-01')), false);
  assert.equal(isLastWindowRun(kst('2026-01-02')), true);
  // 2027: 1일 금·2일 토·3일 일 → 1일이 마지막
  assert.equal(isLastWindowRun(kst('2027-01-01')), true);
  // 2028: 1일 토·2일 일·3일 월 → 3일이 마지막
  assert.equal(isLastWindowRun(kst('2028-01-03')), true);
  // 2029: 1일 월·2일 화·3일 수
  assert.equal(isLastWindowRun(kst('2029-01-02')), false);
  assert.equal(isLastWindowRun(kst('2029-01-03')), true);
  // 창 밖(수동 --force 등)에서는 알리지 않는다
  assert.equal(isLastWindowRun(kst('2029-01-04')), false);
  assert.equal(isLastWindowRun(kst('2029-06-03')), false);
  // KST 경계: UTC로는 12월 31일이지만 KST로는 1월 1일
  assert.equal(isLastWindowRun(new Date('2026-12-31T16:00:00Z')), true, 'KST 2027-01-01(금)');
});

test('isPartialReplacement: 재실행 때 이미 대기·승인 중인 다리(pending)는 보낸 것, 오너가 거부한 다리(cooldown)는 반쪽이 아님', () => {
  const created = { action: 'created' };
  const pending = { action: 'pending', reason: '같은 안건이 이미 승인 상태' };
  const cooldown = { action: 'blocked', blockedBy: 'cooldown' };
  const openOrder = { action: 'blocked', blockedBy: 'open-order' };
  const failed = { action: 'failed' };
  assert.equal(isLegSent(pending), true);
  assert.equal(isPartialReplacement(created, created), false);
  assert.equal(isPartialReplacement(pending, pending), false, '어제 보낸 교체를 재실행해도 반쪽 경고 없음');
  assert.equal(isPartialReplacement(pending, created), false);
  assert.equal(isPartialReplacement(cooldown, failed), false, '매도를 거부당했으면 매수는 시도 안 함');
  assert.equal(isPartialReplacement(created, cooldown), false);
  assert.equal(isPartialReplacement(created, failed), true);
  assert.equal(isPartialReplacement(failed, failed), true);
  assert.equal(isPartialReplacement(openOrder, failed), true, '그해 기록 밖의 주문 진행 중 차단만 반쪽(수동 확인)');
  const decided = { action: 'decided' };
  assert.equal(isLegSent(decided), true);
  assert.equal(isPartialReplacement(decided, decided), false, '그해 승인·주문 진행·체결된 교체는 재실행해도 반쪽 경고 없음(리뷰 2차 MEDIUM 3)');
  assert.equal(isPartialReplacement(decided, pending), false);
  assert.equal(isPartialReplacement(decided, failed), true, '매도는 끝났는데 매수가 실패하면 여전히 반쪽');
});

test('제안 호출은 keepPending으로 재실행 때 대체 발송하지 않는다(리뷰 HIGH 회귀 방지)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./annual-instrument-rescore.mjs', import.meta.url), 'utf8');
  const calls = src.split('createAndSendProposal({').slice(1).map((chunk) => chunk.slice(0, chunk.indexOf('});')));
  assert.equal(calls.length, 2, '매도·매수 두 호출');
  for (const call of calls) assert.match(call, /keepPending: true/);
});

test('normalizeProgress·instrumentKey: 그해 판정(유지·교체)만 남기고, 연도가 바뀌거나 깨진 기록은 새 해로 비운다', () => {
  assert.deepEqual(normalizeProgress(null, '2027'), { year: '2027', verdicts: {}, alertedFor: null });
  assert.deepEqual(normalizeProgress({ year: '2026', verdicts: { '위탁|A': { verdict: '유지' } }, alertedFor: '2026' }, '2027'),
    { year: '2027', verdicts: {}, alertedFor: null });
  assert.deepEqual(normalizeProgress({ year: '2027', verdicts: { '위탁|A': { verdict: '유지', reasoning: 'r' }, '위탁|B': { verdict: '모름' }, '위탁|C': 3,
    '위탁|D': { verdict: '교체', reasoning: 'x', alternative: 'KODEX 대안' }, '위탁|E': { verdict: '교체', reasoning: '대안 없음' } }, alertedFor: '2027' }, '2027'),
  { year: '2027', verdicts: { '위탁|A': { verdict: '유지', reasoning: 'r' }, '위탁|D': { verdict: '교체', reasoning: 'x', alternative: 'KODEX 대안' } }, alertedFor: '2027' },
  '교체는 대안 이름이 있을 때만 재사용(없으면 다시 판단)');
  assert.equal(instrumentKey('위탁', { ticker: '360750', name: 'TIGER' }), '위탁|360750');
  assert.equal(instrumentKey('연금저축', { name: 'KODEX' }), '연금저축|KODEX');
});

test('readProgress: 없으면 새 해, 깨졌으면 빈 기록으로 덮지 않고 이번 실행을 보류(fail-closed)', async (t) => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'rescore-progress-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'progress.json');
  assert.deepEqual(readProgress('2027', { path }), { year: '2027', verdicts: {}, alertedFor: null });
  writeFileSync(path, '{"year":"2027","verdicts":');
  assert.throws(() => readProgress('2027', { path }), /읽을 수 없음 — 이번 실행 보류/);
  writeFileSync(path, JSON.stringify({ year: '2027', verdicts: { '위탁|A': { verdict: '유지' } }, alertedFor: '2027' }));
  assert.equal(readProgress('2027', { path }).alertedFor, '2027');
});

test('isWindowEnded: 창 마지막 실행일과 창이 지난 뒤(수동 --force)만 알림 시점', () => {
  const kst = (d) => new Date(`${d}T10:00:00+09:00`);
  assert.equal(isWindowEnded(kst('2029-01-02')), false, '창 안, 뒤에 평일 남음');
  assert.equal(isWindowEnded(kst('2029-01-03')), true, '창 마지막');
  assert.equal(isWindowEnded(kst('2029-01-05')), true, '마지막 날을 놓친 뒤 첫 실행');
  assert.equal(isWindowEnded(kst('2029-03-01')), true);
  assert.equal(isWindowEnded(kst('2026-01-01')), false);
});

test('재실행 회귀(리뷰 HIGH): 같은 종목·방향 제안이 대기·승인 중이면 keepPending으로 발송 0건·기존 제안 그대로, 거부 쿨다운은 반쪽 아님', async () => {
  const NOW = new Date('2027-01-02T01:00:00Z');
  const sent = [];
  const written = [];
  const base = { track: '자산분배', account: '위탁', name: 'X', quantity: 1, proposedPrice: 10000, reason: '[연 1회 재스코어링] r', now: NOW, keepPending: true,
    writeProposalFile: async (f, c) => { written.push(f); }, sendMessage: async (m) => { sent.push(m); return { message_id: 9 }; } };
  for (const status of ['대기', '승인']) {
    const existing = { id: `P-${status}`, track: '자산분배', assetKey: 'X', side: '매도', status, createdAt: '2027-01-01T01:00:00Z' };
    const r = await createAndSendProposal({ ...base, assetKey: 'X', side: '매도', existingProposals: [existing] });
    assert.equal(r.action, 'pending', status);
    assert.equal(existing.status, status, '기존 제안 상태가 바뀌지 않는다(대체됨 아님)');
    assert.equal(isPartialReplacement(r, { action: 'pending' }), false);
  }
  assert.deepEqual([sent.length, written.length], [0, 0], '재실행 발송·기록 0건');
  const rejected = { id: 'P-거부', track: '자산분배', assetKey: 'X', side: '매도', status: '거부', decidedAt: '2027-01-01T05:00:00Z', createdAt: '2027-01-01T01:00:00Z' };
  const cooldown = await createAndSendProposal({ ...base, assetKey: 'X', side: '매도', existingProposals: [rejected] });
  assert.deepEqual([cooldown.action, cooldown.blockedBy], ['blocked', 'cooldown']);
  assert.equal(isPartialReplacement(cooldown, { action: 'failed' }), false, '거부 쿨다운은 반쪽 발송 경고를 내지 않는다');
  assert.equal(sent.length, 0);
});

test('배선: 실패 종목만 다시 판단(그해 판정 재사용), 판단 실패·한도 보류를 모아 창 끝 한 해 1회 알림, 알림에 오류 원문 없음', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./annual-instrument-rescore.mjs', import.meta.url), 'utf8');
  assert.match(src, /let verdict = progress\.verdicts\[instrumentKey\(account, inst\)\] \?\? null;/);
  assert.match(src, /\n\s+if \(!verdict\) try \{/, '저장된 판정이 있으면 claude를 부르지 않는다');
  assert.match(src, /const step = decideReplacementStep\(\{ cached: verdict, bestAlternativeName: evaluation\.bestAlternative\.name, sellState, buyState, forceOutsideWindow \}\);/);
  assert.match(src, /if \(step\.action === 'skip'\)[^\n]*continue; \}/);
  assert.match(src, /if \(sellState === 'decided'\) \{/, '그해 결정이 끝난 매도 다리는 다시 보내지 않는다');
  assert.match(src, /if \(isSent\(sellResult\) && buyState === 'decided'\) \{/, '그해 결정이 끝난 매수 다리는 다시 보내지 않는다');
  assert.match(src, /alternative: evaluation\.bestAlternative\.name/, '교체 판정은 대안 이름과 함께 남긴다');
  assert.match(src, /await writeStateFile\(PROGRESS_FILE/, '진행 기록은 잠금 쓰기');
  assert.match(src, /judgmentFailures\.push\(/);
  assert.match(src, /limitHeld\.push\(/);
  assert.match(src, /\(judgmentFailures\.length \|\| limitHeld\.length \|\| dataFailures\.length \|\| windowNotes\.length\) && isWindowEnded\(now\) && progress\.alertedFor !== progress\.year/);
  assert.match(src, /dataFailures\.push\(/);
  assert.match(src, /if \(step\.note\) windowNotes\.push\(/);
  assert.match(src, /progress\.alertedFor = progress\.year;/);
  const alertBlock = src.slice(src.indexOf('INSTRUMENT_RESCORE_JUDGMENT_FAILED') - 400, src.indexOf('INSTRUMENT_RESCORE_JUDGMENT_FAILED') + 200);
  assert.doesNotMatch(alertBlock, /e\.message/, '알림 본문에 오류 원문을 넣지 않는다');
  assert.match(alertBlock, /kind: 'operational', severity: 'medium'/);
  assert.match(src, /judgmentFailureCount: judgmentFailures\.length/, '연 마커 미전진은 남은 실패로 판단');
});

test('buildWindowEndFacts: 실패·한도 보류 종목과 건수만(오류 원문 없음), 5건을 넘으면 "외 N건"', () => {
  const failures = Array.from({ length: 6 }, (_, i) => `[위탁] 종목${i}`);
  const facts = buildWindowEndFacts({ judgmentFailures: failures, limitHeld: ['[연금저축] 펀드A'] });
  assert.match(facts[0], /판단 실패 6건 · 사용량 한도 보류 1건/);
  assert.ok(facts.includes('외 2건'));
  assert.ok(!facts.some((line) => /종료코드|Error|unknown option/.test(line)));
  assert.match(buildWindowEndFacts({ judgmentFailures: [], limitHeld: ['[위탁] B'] }).join('\n'), /\[위탁\] B\(한도 보류\)/, '마지막 날 한도 보류만 남아도 알림 문구가 된다');
});

test('legYearState: 그해 이 잡이 낸 같은 계좌·종목·방향 제안의 최근 상태(다른 잡 제안·작년 제안·결함 거부 제외)', () => {
  const p = (extra) => ({ track: '자산분배', account: '위탁', assetKey: 'A', side: '매도', reason: `${RESCORE_REASON_TAG} r`, createdAt: '2027-01-01T01:00:00Z', ...extra });
  const q = { account: '위탁', assetKey: 'A', side: '매도', year: '2027' };
  assert.equal(legYearState([], q), null);
  assert.equal(legYearState([p({ status: '거부' })], q), 'rejected');
  assert.equal(legYearState([p({ status: '거부', rejectTag: '결함' })], q), null, '결함 거부는 오너 판단이 아니다');
  for (const status of ['승인', '실행대기', '주문접수', '부분체결', '체결', '실행됨']) assert.equal(legYearState([p({ status })], q), 'decided', status);
  assert.equal(legYearState([p({ status: '대기' })], q), 'pending');
  assert.equal(legYearState([p({ status: '대체됨' }), p({ status: '대기', createdAt: '2027-01-02T01:00:00Z' })], q), 'pending', '가장 최근 것');
  assert.equal(legYearState([p({ status: '거부', createdAt: '2026-01-02T01:00:00Z' })], q), null, '작년 거부');
  assert.equal(legYearState([p({ status: '승인', reason: '신규 현금 배분' })], q), null, '다른 잡 제안은 교체 다리가 아니다');
  assert.equal(legYearState([p({ status: '승인', account: '연금저축' })], q), null, '다른 계좌');
});

test('decideReplacementStep: 오너 거부는 유지 확정, 창 밖 --force는 저장 판정으로 발송 안 함, 대안이 바뀌면 다시 판단(이미 나간 교체면 건너뜀)', () => {
  const base = { cached: null, bestAlternativeName: 'X', sellState: null, buyState: null, forceOutsideWindow: false };
  assert.equal(decideReplacementStep(base).action, 'proceed');
  assert.equal(decideReplacementStep({ ...base, sellState: 'rejected', cached: { verdict: '교체', alternative: 'X' } }).action, 'keep');
  assert.equal(decideReplacementStep({ ...base, buyState: 'rejected' }).action, 'keep');
  assert.equal(decideReplacementStep({ ...base, cached: { verdict: '유지' }, forceOutsideWindow: true }).action, 'skip');
  assert.equal(decideReplacementStep({ ...base, forceOutsideWindow: true }).action, 'proceed', '저장 판정이 없으면 수동 실행은 새로 판단');
  assert.equal(decideReplacementStep({ ...base, cached: { verdict: '교체', alternative: 'X' } }).action, 'proceed', '대안이 같으면 재사용');
  assert.equal(decideReplacementStep({ ...base, cached: { verdict: '교체', alternative: 'Y' } }).action, 'rejudge', '대안이 바뀌고 나간 제안이 없으면 다시 판단');
  for (const sellState of ['pending', 'decided']) {
    assert.equal(decideReplacementStep({ ...base, cached: { verdict: '교체', alternative: 'Y' }, sellState }).action, 'skip', `${sellState}: 매수 제안 둘 방지`);
  }
});

test('yearMarkerHold: 교체 판단 뒤 평가액·대안 가격 확인 실패도 마커 보류', () => {
  assert.match(yearMarkerHold({ hadLimitError: false, hadPartialFailure: false, judgmentFailureCount: 0, hadDataFailure: true }), /가격 확인 실패/);
  assert.match(yearMarkerHold({ hadLimitError: true, hadPartialFailure: true, judgmentFailureCount: 2, hadDataFailure: true }),
    /가격 확인 실패 · 사용량 한도 보류 · 반쪽 발송된 교체 · 판단 실패/, '사유가 겹치면 모두 이어 붙인다');
});

test('decideReplacementStep: 한쪽만 거부되고 반대쪽 다리가 남으면 유지 확정 + 남은 다리 메모(리뷰 3차 M1)', () => {
  const base = { cached: { verdict: '교체', alternative: 'X' }, bestAlternativeName: 'X', forceOutsideWindow: false };
  const buyRejected = decideReplacementStep({ ...base, sellState: 'decided', buyState: 'rejected' });
  assert.deepEqual([buyRejected.action, buyRejected.note], ['keep', '매수 거부 — 매도 다리 남음']);
  const sellRejected = decideReplacementStep({ ...base, sellState: 'rejected', buyState: 'pending' });
  assert.deepEqual([sellRejected.action, sellRejected.note], ['keep', '매도 거부 — 매수 다리 남음']);
  assert.equal(decideReplacementStep({ ...base, sellState: 'rejected', buyState: null }).note, undefined, '남은 다리가 없으면 메모 없음');
});

test('decideReplacementStep: 저장 판정 없이 그해 교체 다리가 나가 있으면 새 다리를 만들지 않음(리뷰 3차 M2)', () => {
  const base = { cached: null, bestAlternativeName: 'B', forceOutsideWindow: false };
  for (const [sellState, buyState] of [['pending', null], ['decided', null], [null, 'pending']]) {
    const step = decideReplacementStep({ ...base, sellState, buyState });
    assert.equal(step.action, 'skip', `${sellState}/${buyState}`);
    assert.match(step.note, /판정 기록 없음/);
  }
  assert.equal(decideReplacementStep({ ...base, sellState: null, buyState: null }).action, 'proceed', '나간 다리가 없으면 새로 판단');
});

test('buildWindowEndFacts: 데이터 확인 실패와 남은 상태 메모도 넣고, 메모만 있으면 마커 문구 없이 알린다', () => {
  const facts = buildWindowEndFacts({ judgmentFailures: [], limitHeld: [], dataFailures: ['[위탁] A'], notes: ['[위탁] B — 매수 거부 — 매도 다리 남음'] });
  assert.match(facts[0], /데이터 확인 실패 1건/);
  assert.ok(facts.includes('[위탁] A(데이터 확인 실패)'));
  assert.ok(facts.includes('[위탁] B — 매수 거부 — 매도 다리 남음'));
  const notesOnly = buildWindowEndFacts({ judgmentFailures: [], limitHeld: [], notes: ['[위탁] C — 매도 부분체결 남음'] });
  assert.match(notesOnly[0], /오너 확인이 필요한 교체 상태/);
  assert.ok(!notesOnly.some((l) => /연 마커/.test(l)));
});
