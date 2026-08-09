// 체결 완료된 제안 ID의 영속 목록 — Phase 11(2026-08-09) 실전 전환 전 필수로 명시돼
// 있던 갭을 메운다. execute-quant-proposal.mjs 파일 상단 주석: order-gate.checkIdempotency가
// 요구하는 alreadyExecutedIds가 지금까지 매 실행마다 빈 배열([])로 새로 시작해, settleExecution
// 성공과 그 결과를 Proposal 파일에 쓰는 것 사이에 크래시가 나면 재실행 시 같은 제안이 다시
// 체결될 수 있었다(섀도우모드에선 로그 한 줄 더뿐이라 무해했지만 실주문에선 중복 매수/매도).
//
// State/ExecutedOrders.md — 킬스위치·체결모드와 동일 원칙("시스템 전체에 하나뿐인 상태"라
// 폴더가 아니라 단일 파일). vault-frontmatter.mjs는 의도적으로 평평한(중첩 없는) key:value
// 전용이라 배열을 직접 못 담는다 — 새 중첩 포맷을 만드는 대신 콤마join 문자열 하나로 담는다
// (제안 ID는 proposal-vault.mjs buildProposalRecord가 track-side-assetKey-timestamp를
// sanitizeSegment로 만들어 콤마가 절대 안 섞인다 — 안전).
import { readFileSync } from 'node:fs';
import { withLock, writeAtomic } from './state-writer.mjs';
import { buildFrontmatter, parseFrontmatter } from './vault-frontmatter.mjs';

// 파일 없음(ENOENT, 최초 실행 — 빈 목록이 정말로 맞는 상태)만 null로 조용히 폴백한다.
// 그 외 오류(권한 문제·파일시스템 손상 등)는 그대로 throw — 코드리뷰 지적(2026-08-09,
// LOW): 모든 읽기 오류를 삼키면 ExecutedOrders.md가 손상됐을 때 멱등체크 전체가 무음으로
// "빈 목록"이 돼 이중 실주문 방지 장치가 조용히 꺼진다. 돈이 걸린 코드는 "모르면 중단"이
// "모르면 빈 값으로 진행"보다 항상 안전하다.
function readOrNull(filePath) {
  try { return readFileSync(filePath, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

// content(파일 미존재 시 null) → 이미 체결된 제안 ID 배열. 순수함수 — 테스트 가능.
export function parseExecutedOrderIds(content) {
  if (!content) return [];
  const { ids } = parseFrontmatter(content);
  if (typeof ids !== 'string' || !ids) return [];
  return ids.split(',').map((s) => s.trim()).filter(Boolean);
}

// 파일에서 직접 읽어 파싱 — execute-quant-proposal.mjs가 buildGateInput에 넘길 때 사용.
export function loadExecutedOrderIds(filePath) {
  return parseExecutedOrderIds(readOrNull(filePath));
}

// proposalId를 영속 목록에 추가(이미 있으면 그대로 — 멱등). 락으로 감싼 read-modify-write라
// 여러 잡이 거의 동시에 실행돼도 유실 없음(state-writer.mjs 20-동시요청 검증과 동일 보장
// 패턴 — withLock이 파일 하나를 두고 경합하는 모든 호출을 직렬화한다). 반환값: 실제로 새로
// 추가됐으면 true, 이미 있었으면 false(호출부가 "혹시 중복 기록이었나" 알 수 있게).
export async function recordExecutedOrder(filePath, proposalId) {
  // 콤마join 포맷의 유일한 위험 지점 — proposalId 자체에 콤마가 섞이면 목록이 조용히
  // 깨진다(실제로는 sanitizeSegment가 assetKey/side를 정제해 사실상 안 생기지만, "안
  // 생길 것"을 가정하지 않고 명시적으로 막는다 — 추정 금지 원칙).
  if (String(proposalId ?? '').includes(',')) {
    throw new Error(`제안 ID에 콤마 포함 — 영속 목록 포맷과 충돌: ${proposalId}`);
  }
  return withLock(filePath, () => {
    const ids = parseExecutedOrderIds(readOrNull(filePath));
    if (ids.includes(proposalId)) return false;
    writeAtomic(filePath, buildFrontmatter({ ids: [...ids, proposalId].join(',') }));
    return true;
  });
}

// recordExecutedOrder로 "선점"했지만(claim) 실제 브로커 주문 자체가 실패한 경우의 롤백 —
// 선점을 풀어야 다음 실행에서 재시도 가능해진다(안 풀면 실제로는 한 번도 체결 안 된 제안이
// "이미 체결됨"으로 영구 고착돼 영영 재시도 못 함). 보안리뷰 지적(2026-08-09, Medium#1)
// 반영 — execute-quant-proposal.mjs가 "주문 직전 선점 → 실패 시 즉시 롤백" 패턴으로
// liveExecutor 안에서 원자적으로 쓴다. 목록에 없으면(애초에 선점 안 됨) 조용히 무시.
export async function unrecordExecutedOrder(filePath, proposalId) {
  return withLock(filePath, () => {
    const ids = parseExecutedOrderIds(readOrNull(filePath));
    if (!ids.includes(proposalId)) return false;
    writeAtomic(filePath, buildFrontmatter({ ids: ids.filter((id) => id !== proposalId).join(',') }));
    return true;
  });
}
