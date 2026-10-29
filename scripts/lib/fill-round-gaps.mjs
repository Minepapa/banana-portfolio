// 체결 알림 차수 빈칸 감지 — 알림 누락 안전망(요청 "연금저축 미국배당다우존스 매도 3주
// 체결 누락", 2026-10-29).
//
// 배경: 2026-10-27 13:40 삼성증권 연금저축 TIGER 미국배당다우존스 매도 30주가 14건으로
// 분할 체결됐는데, 카카오 알림 앱과 아르고스 둘 다 6차(2주)·13차(1주)를 받지 못했다.
// 받은 12건의 알림 시각은 정확히 약 0.6초 간격이었고 12차→4차 사이만 1.72초(세 칸)가
// 비어 있었다 — 카카오톡이 한 알림 갱신에 메시지를 묶었는데 폰 수신부가 마지막 줄만
// 읽은 것으로 본다. 폰 수신부를 고쳐도 다른 이유로 또 빠질 수 있으니, 맥에서 "체결(N차)"
// 번호의 빈칸을 보고 오너에게 바로 묻는다. 장부는 추정으로 채우지 않는다.
//
// 한계(의도적): 같은 날 같은 종목·구분을 주문 두 개로 나눠 체결하면 차수가 1부터 다시
// 시작해 합집합만 본다 — 한 주문의 빈칸이 다른 주문의 같은 번호에 가려질 수 있다.
// 주문번호가 없는 알림이라 주문을 가를 근거가 없다.

import { escapeHtml } from './telegram.mjs';

export const FILL_ROUND_SETTLE_MS = 10 * 60 * 1000;

const dayOf = (tradeDate) => String(tradeDate ?? '').slice(0, 10);

export function fillRoundGroupKey(execution) {
  return [dayOf(execution.tradeDate), execution.broker ?? '', execution.account ?? '',
    execution.stockName ?? '', execution.tradeType ?? ''].join('|');
}

// executions: 원장 체결 기록(frontmatter + filepath). 차수가 있는 기록만 묶는다.
// 묶음의 마지막 기록이 settleMs보다 최근이면 아직 알림이 오는 중일 수 있어 건너뛴다.
export function findFillRoundGaps(executions, { now = Date.now(), settleMs = FILL_ROUND_SETTLE_MS } = {}) {
  const groups = new Map();
  for (const execution of executions) {
    const round = Number(execution.fillRound);
    if (!Number.isInteger(round) || round < 1) continue;
    const key = fillRoundGroupKey(execution);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...execution, fillRound: round });
  }

  const gaps = [];
  for (const [key, all] of groups) {
    const latestRecordedAt = Math.max(...all.map((r) => Date.parse(r.recordedAt) || 0));
    if (now - latestRecordedAt < settleMs) continue;
    // 같은 이벤트(sourceEventId)가 원장에 두 번 있으면 한 번만 센다(재전송으로 파일명만 다른 경우).
    const seen = new Set();
    const records = all.filter((r) => {
      if (!r.sourceEventId) return true;
      if (seen.has(r.sourceEventId)) return false;
      seen.add(r.sourceEventId);
      return true;
    });
    const counts = new Map();
    for (const r of records) counts.set(r.fillRound, (counts.get(r.fillRound) ?? 0) + 1);
    const maxRound = Math.max(...counts.keys());
    const missing = [];
    for (let n = 1; n < maxRound; n++) if (!counts.has(n)) missing.push(n);
    // 같은 차수가 다른 이벤트로 두 번 오면 같은 체결이 이중 반영됐을 수 있다(폰이 알림 시각과
    // 메시지 시각을 섞어 같은 메시지를 다른 문서로 보낸 경우 등, 독립 리뷰 2026-10-29). 같은 날
    // 같은 종목을 주문 두 개로 나눠 체결해도 생기므로 단정하지 않고 묻는다.
    const duplicated = [...counts].filter(([, c]) => c > 1).map(([n]) => n).sort((a, b) => a - b);
    if (!missing.length && !duplicated.length) continue;
    // 알림을 보낸 표시는 차수가 가장 큰 기록에 남긴다. 목록이 같으면 다시 묻지 않고,
    // 새 빈칸·중복이 생기거나 일부가 채워져 목록이 달라지면 다시 묻는다.
    const anchor = records.reduce((a, b) => (b.fillRound > a.fillRound ? b : a));
    const missingKey = `${missing.join(',')}${duplicated.length ? `|dup:${duplicated.join(',')}` : ''}`;
    const notified = all.some((r) => String(r.fillRoundGapNotified ?? '') === missingKey);
    gaps.push({
      key, day: dayOf(anchor.tradeDate), broker: anchor.broker, account: anchor.account,
      stockName: anchor.stockName, tradeType: anchor.tradeType,
      receivedRounds: [...counts.keys()].sort((a, b) => a - b),
      receivedQuantity: records.reduce((sum, r) => sum + (Number(r.quantity) || 0), 0),
      maxRound, missing, duplicated, missingKey, anchor, notified,
    });
  }
  return gaps;
}

// 결론·맥락·의사결정 모두 스크립트가 만든 고정 문구라 llm: false(가는 선)로 보낸다.
export function fillRoundGapMessage(gap) {
  const rounds = (list) => list.map((n) => `${n}차`).join('·');
  const stockName = escapeHtml(gap.stockName ?? '');
  const problems = [
    ...(gap.missing.length ? [`${gap.missing.length}건이 빠졌습니다(${rounds(gap.missing)})`] : []),
    ...(gap.duplicated.length ? [`같은 차수가 두 번 들어왔습니다(${rounds(gap.duplicated)})`] : []),
  ];
  return {
    agent: 'plutus', kind: '판단', topic: '체결 알림 점검', llm: false,
    conclusion: `${stockName} ${gap.tradeType} 체결 알림 ${problems.join(', ')}.`,
    facts: [
      `날짜: ${gap.day}`,
      `계좌: ${escapeHtml(gap.account || '미상')} (${escapeHtml(gap.broker ?? '')})`,
      `받은 차수: ${gap.receivedRounds.join('·')} (최대 ${gap.maxRound}차)`,
      `받은 수량 합계: ${gap.receivedQuantity}주`,
      ...(gap.missing.length ? [`빠진 차수: ${rounds(gap.missing)}`] : []),
      ...(gap.duplicated.length ? [`두 번 들어온 차수: ${rounds(gap.duplicated)}`] : []),
    ],
    context: gap.missing.length
      ? '빠진 차수의 수량은 알림이 없어 장부에 넣지 않았습니다. 보유 수량이 실제와 다를 수 있습니다.'
      : '같은 체결이 두 번 반영됐거나, 같은 날 주문을 두 번 나눠 체결했을 수 있습니다. 보유 수량이 실제와 다를 수 있습니다.',
    decisions: [
      '실계좌의 체결 내역과 보유 수량을 확인해 알려 주세요.',
      '확인 결과에 맞춰 오너 확인 체결로 장부를 고칩니다.',
    ],
  };
}
