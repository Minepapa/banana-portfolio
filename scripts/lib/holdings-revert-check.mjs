// 보유 파일이 옛 버전으로 되돌아간 흔적을 찾는 순수 판정(읽기 전용, 쓰기·발송 없음).
//
// ⚠️ 실사고(2026-10-28) — 위탁 알파벳 22주 전량 매도가 반영돼 보유 파일이 지워졌는데,
// 같은 날 볼트 동기화(LiveSync) 이상으로 10-23 시점 옛 사본(20주, 적용 키 1개)이
// 되살아났다. 이후 매수가 그 위에 쌓여 28주(실제 8주)로 보였다. 체결 원장은 정상이고
// 모든 체결이 holdingsApplied:true였다 — 즉 "반영됐다고 표시된 체결이 보유 파일의 적용
// 키 목록에 없다"는 것이 되돌아감의 지문이다. 예방이 아니라 하루 안에 알리는 감지용이다.
//
// 판정: 보유 파일의 적용 키에 해당하는 체결 중 가장 먼저 반영된 시각(holdingsAppliedAt)을
// 기준점으로, 그 뒤에 반영된 같은 계좌·종목 체결 중 키 목록에 없는 것이 있으면 이상.
// 기준점 이전 반영분은 전량청산 전 이력(파일 삭제와 함께 키도 사라짐)이라 보지 않는다.
// 한계: 키가 빈 상태로 되돌아가거나(옛 마이그레이션 파일), 다른 파일명의 사본으로
// 되살아나 로트 통합(consolidateLots)에 합쳐지는 경우는 이 판정으로 잡지 못한다.
import { parseAppliedDedupKeys } from './holdings-vault-writer.mjs';
import { escapeHtml } from './telegram.mjs';

// IRP·퀀트는 API 잔고가 정본이다. 해당 동기화(reconcile-irp 등)가 appliedDedupKeys를
// 재설정하므로 원장 체결과 키를 일대일 대조하면 정상 상태도 누락으로 오인한다.
export function isExternallyManagedAccount(account) {
  return account === 'IRP' || account === '퀀트';
}

function sameHolding(execution, holding) {
  return execution.account === holding.account && execution.stockName === holding.name;
}

export function findRevertedHoldings(executions, holdings) {
  const anomalies = [];
  for (const holding of holdings) {
    if (!holding?.account || !holding.name || holding.isCashLike) continue;
    if (isExternallyManagedAccount(holding.account)) continue;
    // 옛 마이그레이션 파일엔 null 키가 섞여 있다. 문자열 키만 기준점·대조에 쓴다.
    const keys = parseAppliedDedupKeys(holding).filter((key) => typeof key === 'string' && key);
    if (!keys.length) continue;
    const applied = new Set(keys);
    // 기준점은 체결시각이 아니라 실제 반영 시각(holdingsAppliedAt, 반영 경로 전부가 찍는다).
    // 체결시각 축은 처리 순서와 어긋난다: NH API 체결은 '날짜 00:00:00'뿐이라 같은 날
    // 전량매도→재매수가 같은 시각이 되고, 알림 누락분을 나중에 오너 확인으로 반영하면
    // 과거 체결시각의 키가 새 파일에 들어와 기준점이 옛 로트 쪽으로 당겨진다(독립 리뷰 지적).
    // 반영 시각 축이면 새 파일이 생기기 전에 반영된 체결은 자연히 빠진다.
    const since = executions
      .filter((execution) => sameHolding(execution, holding) && applied.has(execution.dedupKey) && execution.holdingsAppliedAt)
      .map((execution) => String(execution.holdingsAppliedAt))
      .sort()[0];
    // 키에 대응하는 반영 체결을 원장에서 못 찾으면 기준점을 세울 수 없다. 추정하지 않고 건너뛴다.
    if (!since) continue;
    const missing = executions
      .filter((execution) => sameHolding(execution, holding)
        && execution.holdingsApplied === true
        && !execution.legacy
        && !execution.duplicateOf
        // dedupKey 없는 체결은 키 목록과 대조할 수 없다(옛 null 키와 같은 내력).
        && execution.dedupKey
        && String(execution.holdingsAppliedAt ?? '') > since
        && !applied.has(execution.dedupKey))
      .sort((a, b) => String(a.tradeDate).localeCompare(String(b.tradeDate)))
      .map((execution) => ({
        tradeDate: execution.tradeDate, tradeType: execution.tradeType,
        quantity: execution.quantity, dedupKey: execution.dedupKey,
      }));
    if (missing.length) anomalies.push({ account: holding.account, name: holding.name, qty: holding.qty, missing });
  }
  return anomalies.sort((a, b) => `${a.account}|${a.name}`.localeCompare(`${b.account}|${b.name}`));
}

// 판단·이상 보고 4단 구조. 결론·맥락·의사결정은 스크립트 고정 문구라 llm:false.
export function buildRevertedHoldingsMessage(anomalies) {
  // 종목마다 사실 한 항목, 빠진 체결은 그 아래 한 줄씩(쉼표로 잇지 않는다, 폰 한 줄 폭).
  // 종목마다 사실 한 항목, 빠진 체결은 그 아래 한 줄씩(쉼표로 잇지 않는다, 폰 한 줄 폭).
  const facts = anomalies.map(({ account, name, qty, missing }) => {
    const lines = missing.slice(0, 5).map((item) => `${String(item.tradeDate).slice(5, 10)} ${item.tradeType} ${item.quantity}주`);
    if (missing.length > lines.length) lines.push(`외 ${missing.length - lines.length}건`);
    // 종목명에 &가 들어간다(예: TIGER 미국S&P500). HTML 발송이라 이스케이프한다.
    return [`${escapeHtml(account)} ${escapeHtml(name)}: 보유 파일 ${qty}주, 빠진 체결 ${missing.length}건`, ...lines].join('\n');
  });
  // 판정이 적용 키 목록 기준이라 수량만 고치면 다음 실행에도 같은 경고가 나간다.
  const decisions = [
    '증권사 앱 잔고와 대조해 실제 수량을 확인해 주세요.',
    '정정은 개발 세션이 원장 대조(verify-holdings-replay) 뒤 보유 수량과 적용 키 목록을 함께 고칩니다.',
  ];
  return {
    agent: 'plutus', kind: '판단', topic: '경고', llm: false,
    conclusion: `보유 파일 ${anomalies.length}종목이 옛 버전으로 되돌아갔을 가능성이 있습니다.`,
    facts,
    context: '원장에는 반영 완료로 표시된 체결이 보유 파일의 적용 기록에서 빠져 있습니다. 볼트 동기화가 옛 사본을 되살린 2026-10-28 알파벳 사고와 같은 모양입니다.',
    decisions,
  };
}

// 같은 이상 묶음(subjectKey)은 KST 하루 1회만 알린다(2026-11-02 제우스·클리오 지적).
// 이 잡은 평일 16:05 단독 실행 외에 intraday-portfolio-sync(10분 주기) 안에서도 돌아,
// 억제가 없으면 이상이 남은 동안 10분마다 같은 경고가 나간다. 나머지 실행은 로그만 남긴다.
// 상태는 볼트 밖 작은 JSON({ sent: { [subjectKey]: 'YYYY-MM-DD' } })이고, 오늘 날짜 항목만 남겨 커지지 않는다.
function kstDay(now) {
  return new Date(now.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}

export function decideRevertAlert(state, subjectKey, now = new Date()) {
  const today = kstDay(now);
  return { send: state?.sent?.[subjectKey] !== today, today };
}

export function recordRevertAlert(state, subjectKey, today) {
  const kept = Object.fromEntries(Object.entries(state?.sent ?? {}).filter(([, day]) => day === today));
  return { sent: { ...kept, [subjectKey]: today } };
}
