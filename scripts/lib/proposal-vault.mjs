// Decisions/Proposals 파일(제안 하나당 파일 하나) 빌더·파서·조회 헬퍼 — 순수 함수.
// 실제 파일 I/O는 호출부(scripts/lib/order-gate.mjs가 쓰는 오케스트레이션 잡, 향후
// Phase 5 텔레그램 승인 흐름)가 state-writer.mjs로 수행한다.
//
// 상태 전이: 대기 → (승인|거부|대체됨). 승인 → (체결|섀도우체결). 파일은 상태가 바뀌어도
// 지우지 않고 갱신만 한다 — "왜 거부했는지 나중에 되짚기 위함"(ARCHITECTURE-V2.md
// "실행 흐름(주문)" 절)과 "단일 활성 제안 원칙"의 대체(supersede) 이력 추적을 위해서다.
import { buildFrontmatter, parseFrontmatter } from './vault-frontmatter.mjs';

function sanitizeSegment(s) {
  return String(s ?? '').trim().replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '-');
}

// track+assetKey+side가 같으면 "같은 안건"으로 취급(단일 활성 제안·거부 쿨다운 판정의 키).
export function proposalMatchKey({ track, assetKey, side }) {
  return `${track}|${assetKey}|${side}`;
}

export function buildProposalRecord({ track, account = null, assetKey, side, quantity, proposedPrice, reason = '', now = new Date() }) {
  const ts = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const id = `${track}-${sanitizeSegment(side)}-${sanitizeSegment(assetKey)}-${ts}`;
  const filename = `${id}.md`;
  const content = buildFrontmatter({
    id, track, account, assetKey, side, quantity, proposedPrice, reason,
    status: '대기',
    createdAt: now.toISOString(),
    decidedAt: null,
    executedAt: null,
    rejectReason: null,
    supersededBy: null,
  });
  return { id, filename, content };
}

// 기존 frontmatter 필드에 updates를 병합해 새 content를 만든다(파일 자체를 새로 쓰는 게
// 아니라 같은 파일을 갱신 — 상태 이력은 이 필드들의 최종값만 남고, 언제 뭐가 바뀌었는지의
// 전체 이력이 필요해지면 그건 Phase 5+에서 별도 감사로그를 고려할 문제다. 지금은 "지금
// 상태"만 정확하면 충분).
export function updateProposalRecord(currentContent, updates) {
  const merged = { ...parseFrontmatter(currentContent), ...updates };
  return buildFrontmatter(merged);
}

export function parseProposal(content) {
  return parseFrontmatter(content);
}

// dir 안의 모든 .md 파일을 파싱해 반환. 실제 디렉토리 읽기는 호출부 책임(테스트 용이성
// 위해 이 모듈 자체는 fs를 만지지 않고, 이미 읽은 content 배열을 받는 순수 버전도 아래
// listProposalsFromContents로 제공).
export function listProposalsFromContents(contents) {
  return contents.map((c) => parseProposal(c));
}

// 같은 안건(track+assetKey+side)의 "대기" 상태 제안 중 가장 최근 것 — 없으면 null.
// 있으면 "단일 활성 제안 원칙"에 따라 새 제안이 이걸 대체(supersede)해야 한다.
export function findActiveProposal(proposals, { track, assetKey, side }) {
  const key = proposalMatchKey({ track, assetKey, side });
  const candidates = proposals.filter((p) => p.status === '대기' && proposalMatchKey(p) === key);
  if (!candidates.length) return null;
  return candidates.reduce((latest, p) => (!latest || p.createdAt > latest.createdAt ? p : latest), null);
}

// 같은 안건에 대해 "거부"된 제안 중 withinMs 이내에 결정된 것이 있으면 반환(없으면 null).
// "거부 재상정 쿨다운" 판정용 — 있으면 conditionsChanged를 호출부(부서 판단)가 명시적으로
// true로 넘기지 않는 한 새 제안 생성을 막는다(order-gate.mjs checkRejectionCooldown).
export function findRecentRejection(proposals, { track, assetKey, side, withinMs, now = new Date() }) {
  const key = proposalMatchKey({ track, assetKey, side });
  const cutoff = now.getTime() - withinMs;
  const candidates = proposals.filter(
    (p) => p.status === '거부' && proposalMatchKey(p) === key && p.decidedAt && new Date(p.decidedAt).getTime() >= cutoff,
  );
  if (!candidates.length) return null;
  return candidates.reduce((latest, p) => (!latest || p.decidedAt > latest.decidedAt ? p : latest), null);
}
