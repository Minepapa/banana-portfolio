// 돌파매매 보유 포지션의 매일 청산 관리 — 순수 판정(decideExitManagement)과 실제
// 실행(executeExitManagement)을 분리한다(2026-09-29, breakout-protection.mjs가
// 진입 시점 손절+3R 동시예약에서 손절 단일 다리로 축소된 것과 짝을 이루는 재설계 —
// Log/Strategy/2026-09-28-대한항공보호주문실패-트레일링전환.md "정정 2" 절 참고).
//
// 이 모듈이 다루는 것: 매일 08:35, 보유 중인 포지션 각각에 대해 ①트레일링 손절선을
// 능동으로 올릴지(computeTrailingRevision 재사용) ②3R에 처음 도달했으면 절반을
// 시장가로 팔고 나머지에 새 손절을 걸지를 판정·실행한다. 전량 종료(손절 체결) 감지는
// decidePositionClosure가, 부분익절 시장가 매도의 체결 확인·원장 기록은
// decidePendingPartialExitConfirmation이 별도로 맡는다 — 둘 다 "청산 관리" 자체가
// 아니라 이미 낸 주문의 결과를 확인하는 다른 문제라 개념적으로 분리했다.
//
// ⚠️ 2026-09-29 독립 코드리뷰 CRITICAL 지적으로 재구성됨 — 최초 버전은 "이 종목에
// 매도주문이 전혀 없으면 손절만 새로 건다(placeStop)"와 "3R 도달 시 부분익절
// (partialExit, 기존 손절 취소가 전제)"을 별개 분기로 둬서, 이 잡이 하루 1회만
// 도는 실환경(KIS 스톱주문은 당일유효라 매일 소멸)에서는 매일 무조건 전자만
// 발동하고 3R 부분익절은 영원히 실행될 수 없었다(취소할 기존 주문이 있는 날이
// 없으므로). 이제 "매도주문이 전혀 없음"+"3R 도달"이 겹치면 취소 단계 없이
// 매도→새손절 2단계로 합쳐서(placeStopAndPartialExit) 그 자리에서 처리한다.
import {
  computeTrailingStop, shouldTakePartialProfit, PARTIAL_PROFIT_SELL_FRACTION, STOP_LOSS_PCT,
} from './breakout-risk.mjs';
import { computeTrailingRevision } from './breakout-trailing.mjs';
import { roundToKrxTick } from './krx-tick.mjs';

// KIS 미체결 매도주문 목록에서 "지금 이 포지션의 손절주문"이라고 확신할 수 있는
// 딱 하나를 찾는다 — 옛 손절+3R 동시예약 시절(breakout-morning-protection.mjs,
// 2026-09-29 삭제)의 isExactProtectionLeg 판정(주문유형·수량·조건가·주문가가
// 전부 기록과 정확히 일치)과 동일한 정신, 손절 단일 다리로 단순화.
// 딱 하나로 유일하게 대조되지 않으면(2건 이상, 또는 이 종목에 예상 밖 매도
// 주문이 섞여있으면) 호출측이 review로 넘겨야 한다 — 어떤 주문을 취소·정정할지
// 확신 없이 진행하면 안 된다.
function findMatchingStopOrder(position, sellOrders) {
  const sellOrdersForThisCode = (sellOrders ?? []).filter(
    (o) => o.code === position.code && o.side === '매도' && (o.cancelableQty ?? 0) > 0,
  );
  // 주문번호는 숫자로 정규화해서 비교한다 — getCancelableOrders(정정취소가능주문
  // 조회)가 돌려주는 orderNo와 주문 접수 응답의 orderNo가 0패딩 여부에서 실제로
  // 어긋난 전례가 있다(kis.mjs의 checkOrderFill/parseOrderFillResponse 주석 —
  // "0006693100" vs "6693100", 문자열 비교면 항상 실패). 여기서도 같은 클래스의
  // 데이터 두 출처를 문자열로 비교하고 있었다(2026-09-29 코드리뷰 MEDIUM 지적).
  const matchesOrderNo = (o) => Number(o.orderNo) === Number(position.stopOrderNo);
  const exactMatches = sellOrdersForThisCode.filter((o) => matchesOrderNo(o)
    && o.orderTypeCode === '22'
    && o.quantity === position.quantity
    && o.filledQty === 0
    && o.cancelableQty === position.quantity
    && o.conditionPrice === position.stopPrice
    && o.orderPrice === position.stopPrice);
  return { sellOrdersForThisCode, exactMatches };
}

// 새로 걸(거나 재확인할) 손절가가 이미 최신 확정 종가를 통과했으면(전날 갭다운 등)
// 스톱지정가 주문을 그대로 내지 않는다 — 조건가가 현재가보다 위/같은 스톱매도는
// 즉시 이례적으로 처리되거나 거부될 수 있고, 접수만 되고 "protected"로 잘못
// 기록되면 오너가 안심하게 된다(2026-09-29 코드리뷰 HIGH 지적, 옛 decideMorningProtection
// 의 "현재가가 손절/3R 조건선을 이미 통과" 가드를 재도입).
// export — retry-breakout-protection.mjs(수동 재시도 CLI)도 같은 가드가 필요해
// 재사용한다(2026-09-29 3차 코드리뷰 HIGH 지적, 이 CLI에서 사라졌던 "현재가가
// 손절선을 이미 통과" 검사를 복원하며 로직을 중복 구현하지 않고 이 함수를 쓴다).
export function isAlreadyBreached(latestClose, stopPrice) {
  return latestClose != null && latestClose > 0 && latestClose <= stopPrice;
}

// 반환: { action, urgent?, ... }
// - review: 사람이 봐야 함(주문 안 냄) — reason에 사유. urgent:true면 "포지션이
//   오늘 어떤 손절 보호도 못 받는다"는 뜻(이 잡이 유일한 손절 등록 경로라, 실행
//   안 되면 그 종목은 그날 하루 실질 무보호 — 2026-09-29 코드리뷰 HIGH 지적).
// - none: 조정 불필요. highSinceEntry(추적값 갱신용)만 실어 보낸다.
// - revise: 트레일링 손절선만 정정 필요 — newStopPrice·newHighSinceEntry.
// - placeStop: 이 종목에 살아있는 매도주문이 전혀 없음(당일유효 소멸, 2026-09-23
//   실측 — Log/DevRequests/2026-09-23-돌파매매-보호주문-익일자동재등록-필요.md.
//   이 잡이 매일 도는 이유 자체) + 아직 3R 미도달 — 최신 트레일링가로 전량 새
//   손절만 건다.
// - placeStopAndPartialExit: 매도주문이 전혀 없음 + 3R 최초 도달이 겹친 경우 —
//   취소할 기존 주문이 없으므로 곧장 soldQty 시장가 매도 후 remainingQty에 새
//   손절을 건다(2단계, 취소 단계 불필요).
// - partialExit: 기존 손절주문이 살아있는 상태에서 3R 최초 도달 — 취소→시장가
//   매도→잔여 재예약(3단계).
export function decideExitManagement({
  position, holding, sellOrders, latestHigh, latestClose,
}) {
  if (!position || position.status === '청산') return { action: 'none', reason: '청산 포지션' };
  if (!holding || !Number.isInteger(holding.qty) || holding.qty <= 0) {
    return { action: 'review', urgent: true, reason: 'KIS 잔고에서 보유수량을 확정하지 못함' };
  }
  if (holding.qty !== position.quantity) {
    return { action: 'review', urgent: true, reason: `보유수량 불일치(기록 ${position.quantity}, KIS ${holding.qty}) — 자동 복구 불가, 파일 수동 정정 필요` };
  }
  if (!(latestHigh > 0)) {
    return { action: 'review', urgent: true, reason: '확정 고가를 확인하지 못함(시세 캐시 이상 의심)' };
  }
  const highSinceEntry = Math.max(position.highSinceEntry ?? position.entryPrice, latestHigh);
  const stopLossPct = position.stopLossPct ?? STOP_LOSS_PCT;
  const reachedPartialProfit = position.profitOrderApplicable !== false
    && shouldTakePartialProfit(position.entryPrice, highSinceEntry, position.partialSold === true, stopLossPct);
  const soldQty = reachedPartialProfit ? Math.floor(position.quantity * PARTIAL_PROFIT_SELL_FRACTION) : 0;

  const { sellOrdersForThisCode, exactMatches } = findMatchingStopOrder(position, sellOrders);

  if (sellOrdersForThisCode.length === 0) {
    const newStopPrice = roundToKrxTick(computeTrailingStop(position.entryPrice, highSinceEntry, stopLossPct));
    if (isAlreadyBreached(latestClose, newStopPrice)) {
      return {
        action: 'review', urgent: true,
        reason: `최신 종가(${latestClose})가 계산된 손절선(${newStopPrice}) 이하 — 갭하락 의심, 스톱주문 대신 즉시 수동 확인 필요`,
      };
    }
    if (soldQty > 0) {
      return {
        action: 'placeStopAndPartialExit', position, highSinceEntry,
        soldQty, remainingQty: position.quantity - soldQty, newStopPrice,
      };
    }
    return { action: 'placeStop', position, highSinceEntry, newStopPrice };
  }
  if (exactMatches.length !== 1 || sellOrdersForThisCode.length !== 1) {
    return { action: 'review', urgent: true, reason: '기록 손절주문과 KIS 미체결 매도주문을 유일하게 대조할 수 없음' };
  }
  const matchedStopOrder = exactMatches[0];

  if (soldQty > 0) {
    const newStopPrice = roundToKrxTick(computeTrailingStop(position.entryPrice, highSinceEntry, stopLossPct));
    return {
      action: 'partialExit', position, stopOrder: matchedStopOrder, highSinceEntry,
      soldQty, remainingQty: position.quantity - soldQty, newStopPrice,
    };
  }

  const revision = computeTrailingRevision(position, latestHigh);
  if (revision) return { action: 'revise', position, stopOrder: matchedStopOrder, ...revision };
  return { action: 'none', highSinceEntry };
}

// KIS 호출 하나를 시도하고 이 프로젝트 전체의 confirmedNotSent 계약대로 결과를
// 정규화한다 — 응답에 주문번호가 없으면(성공으로 풀렸어도) 접수 여부를 추적할 수
// 없어 안전하지 않다고 취급(ok:false, confirmedNotSent:false = "불명, 재시도 금지").
async function tryOrderCall(fn, params) {
  try {
    const result = await fn(params);
    if (!result?.orderNo) return { ok: false, confirmedNotSent: false, error: 'KIS 응답에 주문번호 없음' };
    return { ok: true, orderNo: result.orderNo, orgNo: result.orgNo };
  } catch (error) {
    return { ok: false, confirmedNotSent: error.confirmedNotSent === true, error: error.message };
  }
}

// decideExitManagement의 판정을 실제로 실행한다. reviseOrder/placeOrder는 호출측이
// KIS API를 주입한다(테스트 시 스텁 주입 — 이 프로젝트 전체의 DI 패턴).
//
// 시장가 매도가 들어가는 두 액션(partialExit·placeStopAndPartialExit)은 앞 단계가
// "확정 성공"했을 때만 다음 단계로 넘어간다 — 이 파일에서 가장 위험한 부분이다.
// 시장가 매도가 성공(주문 접수 확정)한 뒤로는, 그 다음 단계(잔여 손절 재예약)가
// 실패해도 이미 낸 매도 자체를 취소할 수 없다 — 그래서 성공한 매도 주문번호
// (partialExitOrderNo/OrgNo)는 이후 단계 성패와 무관하게 항상 결과에 실어 보낸다.
// 이 매도는 08:35에 접수돼 09:00 시가단일가에야 체결되므로(체결가를 이 시점엔
// 알 수 없음) 호출측이 이 주문번호로 다음 실행 때 checkOrderFill 확인 후 원장에
// 기록해야 한다(decidePendingPartialExitConfirmation 참고, 2026-09-29 코드리뷰
// HIGH 지적 — 체결 확인 없이 즉시 원장에 기록하면 실제와 다른 값이 남을 수 있음).
//
// 재시도(다음날 재실행)는 이 함수가 반환한 상태를 신뢰하지 않고, 호출측
// (reconcile-breakout-protection.mjs)이 매번 KIS 실제 잔고·미체결주문을 다시
// 조회해 decideExitManagement로 처음부터 재판정한다 — idempotency는 "저장된 진행
// 기록"이 아니라 "KIS 실제 상태 재확인"으로 보장한다.
export async function executeExitManagement(decision, { reviseOrder, placeOrder }) {
  if (decision.action === 'placeStop') {
    const result = await tryOrderCall(placeOrder, {
      side: '매도', quantity: decision.position.quantity, price: decision.newStopPrice, conditionPrice: decision.newStopPrice,
    });
    if (!result.ok) return { status: 'urgentReview', stage: 'placeStop', ambiguous: !result.confirmedNotSent, error: result.error };
    return {
      status: 'completed', stage: 'placeStop', stopOrderNo: result.orderNo,
      stopOrderOrgNo: result.orgNo ?? null, newStopPrice: decision.newStopPrice, highSinceEntry: decision.highSinceEntry,
    };
  }

  if (decision.action === 'placeStopAndPartialExit') {
    const marketSell = await tryOrderCall(placeOrder, { side: '매도', quantity: decision.soldQty, marketOrder: true });
    if (!marketSell.ok) {
      return {
        status: 'urgentReview', stage: 'marketSell', ambiguous: !marketSell.confirmedNotSent,
        error: marketSell.error, steps: { marketSell },
      };
    }
    const newStop = await tryOrderCall(placeOrder, {
      side: '매도', quantity: decision.remainingQty, price: decision.newStopPrice, conditionPrice: decision.newStopPrice,
    });
    const shared = {
      partialExitOrderNo: marketSell.orderNo, partialExitOrgNo: marketSell.orgNo ?? null,
      soldQty: decision.soldQty, remainingQty: decision.remainingQty,
    };
    if (!newStop.ok) {
      return {
        status: 'urgentReview', stage: 'newStop', ambiguous: !newStop.confirmedNotSent,
        error: newStop.error, steps: { marketSell, newStop }, ...shared,
      };
    }
    return {
      status: 'completed', stage: 'newStop', stopOrderNo: newStop.orderNo, stopOrderOrgNo: newStop.orgNo ?? null,
      newStopPrice: decision.newStopPrice, highSinceEntry: decision.highSinceEntry, steps: { marketSell, newStop }, ...shared,
    };
  }

  if (decision.action === 'revise') {
    const orgNo = decision.stopOrder.branchNo || decision.position.stopOrderOrgNo;
    const result = await tryOrderCall(reviseOrder, {
      orgNo, orderNo: decision.stopOrder.orderNo, action: '정정',
      quantity: decision.position.quantity, price: decision.newStopPrice, conditionPrice: decision.newStopPrice,
    });
    if (!result.ok) return { status: 'review', stage: 'revise', ambiguous: !result.confirmedNotSent, error: result.error };
    return {
      status: 'completed', stage: 'revise', stopOrderNo: result.orderNo,
      stopOrderOrgNo: result.orgNo ?? orgNo, newStopPrice: decision.newStopPrice, highSinceEntry: decision.newHighSinceEntry,
    };
  }

  if (decision.action !== 'partialExit') return { status: 'noop' };

  // 기존 손절주문 취소. 애매하면(confirmedNotSent가 아닌 실패) 그 자리에서 멈춘다
  // — 원래 손절주문이 여전히 살아있을 수 있는데 그 위에 매도를 또 내면 안 된다.
  const orgNo = decision.stopOrder.branchNo || decision.position.stopOrderOrgNo;
  const cancel = await tryOrderCall(reviseOrder, {
    orgNo, orderNo: decision.stopOrder.orderNo, action: '취소',
    quantity: decision.position.quantity, price: decision.position.stopPrice, conditionPrice: decision.position.stopPrice,
  });
  if (!cancel.ok) {
    return { status: 'review', stage: 'cancel', ambiguous: !cancel.confirmedNotSent, error: cancel.error, steps: { cancel } };
  }

  // 취소는 확정됐는데 매도 결과가 애매하면 가장 위험한 중간 상태다 — 손절은
  // 확실히 사라졌는데 매도가 됐는지 안 됐는지 불명. 이 경우 남은 수량 전체가
  // 무보호일 수 있다.
  const marketSell = await tryOrderCall(placeOrder, { side: '매도', quantity: decision.soldQty, marketOrder: true });
  if (!marketSell.ok) {
    return {
      status: 'urgentReview', stage: 'marketSell', ambiguous: !marketSell.confirmedNotSent,
      error: marketSell.error, steps: { cancel, marketSell },
    };
  }

  const newStop = await tryOrderCall(placeOrder, {
    side: '매도', quantity: decision.remainingQty, price: decision.newStopPrice, conditionPrice: decision.newStopPrice,
  });
  const shared = {
    partialExitOrderNo: marketSell.orderNo, partialExitOrgNo: marketSell.orgNo ?? null,
    soldQty: decision.soldQty, remainingQty: decision.remainingQty,
  };
  if (!newStop.ok) {
    return {
      status: 'urgentReview', stage: 'newStop', ambiguous: !newStop.confirmedNotSent,
      error: newStop.error, steps: { cancel, marketSell, newStop }, ...shared,
    };
  }

  return {
    status: 'completed', stage: 'newStop', stopOrderNo: newStop.orderNo, stopOrderOrgNo: newStop.orgNo ?? null,
    newStopPrice: decision.newStopPrice, highSinceEntry: decision.highSinceEntry, steps: { cancel, marketSell, newStop }, ...shared,
  };
}

// 포지션이 KIS 잔고에서 사라졌을 때(holding 없음/수량 0) "우리 손절이 체결돼
// 종료됐다"고 조용히 추정하지 않는다 — checkOrderFill로 실제 체결을 확인했을
// 때만(fullyFilled, 수량·가격 확정) close를 반환한다. 확인 안 되면 review —
// 다른 이유로 잔고가 사라졌을 수도 있으니 사람이 봐야 한다.
export function decidePositionClosure({ position, holding, fill }) {
  if (holding?.qty > 0) return { action: 'none' };
  if (fill?.fullyFilled && fill.filledQty === position.quantity && fill.avgFillPrice > 0) {
    return { action: 'close', fill };
  }
  return { action: 'review', reason: '잔고는 없지만 손절 체결을 확정하지 못함' };
}

// 3R 부분익절 시장가 매도(placeStopAndPartialExit·partialExit)는 08:35에 접수돼
// 09:00 시가단일가에야 체결되므로, 주문을 낸 그 실행에서는 체결가를 알 수 없다.
// position.partialExitPendingOrderNo가 있으면(=이전 실행에서 매도를 냈지만 아직
// 확인 안 됨) 다음 실행에서 checkOrderFill로 그 주문의 실제 체결을 확인한 뒤에만
// 원장에 기록한다 — "주문을 냈다"와 "얼마에 팔렸는지 안다"를 섞지 않는다
// (2026-09-29 코드리뷰 HIGH 지적).
//
// 반환 액션 4가지(2026-09-29 2차 코드리뷰 HIGH 지적으로 종결 상태 추가 — 최초
// 버전은 confirm/review 둘뿐이라 취소·부분체결로 끝난 주문이 매일 review만
// 반복하며 영원히 안 풀리는 교착이 가능했다):
// - confirm: 주문수량 그대로 전량 체결 확인 — 정상 경로, 원장 그대로 기록.
// - abandon: 시가단일가 매도 자체가 취소/미체결로 종결(거래정지 등 드문 경우) —
//   0주도 안 팔렸으므로 원장 기록 없이 pending만 해제, 호출측이 수량·partialSold를
//   원복해 재판정해야 한다.
// - partialFill: 주문수량 중 일부만 체결(시가단일가 유동성 부족 등, 드묾) — 체결된
//   만큼만 원장에 기록하고, 안 팔린 나머지는 다시 보호돼야 한다.
// - review: 아직 KIS 체결내역에 안 잡힘(정상 지연) — 다음 실행에서 재확인.
export function decidePendingPartialExitConfirmation({ position, fill }) {
  if (!position?.partialExitPendingOrderNo) return { action: 'none' };
  if (fill?.fullyFilled && fill.filledQty === position.partialExitPendingQty && fill.avgFillPrice > 0) {
    return { action: 'confirm', fill };
  }
  // partialFill·abandon은 둘 다 그 주문이 더 이상 살아있지 않을 때만(취소됐거나
  // remainingQty===0) 종결로 본다(2026-09-29 3차 코드리뷰 HIGH 지적) — 아직
  // 살아있는 주문(remainingQty>0, 취소 안 됨)을 여기서 종결로 잘못 취급하면
  // 그 주문이 나중에 마저 체결됐을 때 원장에 영구히 안 남는다. "얼마나
  // 체결됐는가"를 먼저 보되, canceled/remainingQty로 "이제 더 안 움직인다"를
  // 확인한 경우에만 확정한다.
  const terminal = fill != null && (fill.canceled === true || fill.remainingQty === 0);
  if (terminal && fill.filledQty > 0 && fill.filledQty < position.partialExitPendingQty && fill.avgFillPrice > 0) {
    return { action: 'partialFill', fill };
  }
  // filledQty===0으로 정확히 좁힌다(2026-09-29 5차 코드리뷰 LOW 지적) — tot_ccld_qty
  // 필드가 응답에 아예 없으면 num()이 Number('')===0으로 조용히 0을 만들어내는데,
  // 그걸 `!(filledQty>0)`으로 받으면 "체결수량 정보가 없는 종결 행"까지 abandon(전량
  // 원복+같은 실행에서 재매도 시도)으로 잘못 분류된다. 정말 0인 것과 "모른다"를
  // 구분해야 한다 — 모르면 review로 떨어져 사람이 보게 한다.
  if (terminal && fill.filledQty === 0) {
    return { action: 'abandon', reason: `부분익절 매도(${position.partialExitPendingOrderNo})가 취소/미체결로 종결됨 — 원복 후 재판정 필요` };
  }
  return { action: 'review', reason: `부분익절 매도(${position.partialExitPendingOrderNo}) 체결을 아직 확인 못 함 — 다음 실행에서 재확인` };
}
