// 성향관찰 Vault 레코드 → 프롬프트 주입 공유 유틸. weekly-report.mjs가 유일한 실사용
// 소비자(2026-08-20 Vault 네이티브 재작성). 이 앱의 목적은 일반 시장 분석이 아니라
// "Frank 맞춤 판단"이므로, 평가·리스크·리포트 모든 LLM 판단에 확정된 학습 성향을
// 동일하게 주입한다.
//
// PREF_SHEET는 v1 전용 상수 — drain-eval-queue.mjs(v2 run.sh에 안 걸린 v1 잔존 파일)가
// 아직 이 이름을 import한다. 그 파일 자체를 손대는 건 이번 작업 범위 밖이라, import
// 에러만 안 나게 문자열 그대로 남겨둔다(렌더 결과는 이제 row-array를 안 받으니 그
// 파일에서 실제로 쓰이진 않음 — 애초에 v1 시트 파이프라인 중단으로 이미 죽은 경로).
export const PREF_SHEET = '성향관찰';
//
// 레코드 스키마(Knowledge/Profile/*.md frontmatter):
//   { date, signalType, observation, evidence, vsProfile, confidence, status, updatedAt }
// (구 구글시트 "성향관찰" A~H와 1:1 대응 — 필드명만 named로 바뀜. "type"이 아니라
// "signalType"인 이유: 이 프로젝트의 Vault 레코드 관례상 "type" 필드는 레코드 종류
// 자체를 뜻한다(holding/execution/preference-observation 등) — 관찰의 신호유형까지
// "type"으로 쓰면 그 레코드종류 필드와 충돌한다.)

// records → 프롬프트용 압축 텍스트. signalType·observation·vsProfile·status만. 기각은 제외.
// confirmedOnly=true 면 status='확정'만(평가·리스크·리포트 주입용), false 면 기각 외 전체(관찰 추출용).
export function renderPrefRows(records, { confirmedOnly = false } = {}) {
  const lines = [];
  for (const r of records || []) {
    const obs = String(r.observation ?? '').trim();
    const status = String(r.status ?? '').trim() || '관찰';
    if (!obs || status === '기각') continue;
    if (confirmedOnly && status !== '확정') continue;
    lines.push(`- [${status}] ${String(r.signalType ?? '').trim()}: ${obs}${r.vsProfile ? ` (§3 대비 ${String(r.vsProfile).trim()})` : ''}`);
  }
  return lines.join('\n');
}

// 확정 성향 프롬프트 블록 — drain·risk-monitor 판단에 동일 주입. 명시 성향(§3/Hub 프로필)과
// 함께 판단 기준으로 쓰되, 둘이 다르면 드러난 행동(학습 성향)을 우선한다.
export function prefBlock(confirmedText) {
  return `[확정 학습 성향 — Frank의 실제 행동에서 학습돼 본인이 확인한 성향. 명시 성향(§3 또는 Hub 프로필)과 함께 판단 기준으로 쓸 것. 둘이 다르면 드러난 행동(학습 성향)을 우선.]
${confirmedText || '(아직 확정된 학습 성향 없음 — 명시 성향만 사용)'}`;
}

// 구조조정 안건5 — 승격후보 TTL(4주 무응답 시 자동 관찰 보류). 순수 판정만 하는 함수 —
// 실제 파일 되돌리기(status·updatedAt 갱신)는 호출부(weekly-report.mjs)가 이 결과로
// 수행한다. records는 filepath를 포함해서 넘겨야 호출부가 어느 파일을 고칠지 안다
// (읽을 때 { filepath, ...parseFrontmatter(...) } 형태로 붙여서 넘길 것).
// status가 '승격후보'이고 updatedAt(없으면 date로 폴백)이 ttlWeeks 이상 지난 레코드를
// 찾는다. 날짜 파싱 불가 시 판정을 보류한다(추정 금지 — 이 세션의 숫자 무결성 원칙과 동일선상).
const WEEK_MS = 7 * 24 * 3600_000;

export function findExpiredPromotions(records, { now = new Date(), ttlWeeks = 4 } = {}) {
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  const out = [];
  (records || []).forEach((r) => {
    if (String(r?.status ?? '').trim() !== '승격후보') return;
    const tsStr = String(r?.updatedAt ?? '').trim() || String(r?.date ?? '').trim();
    const ts = Date.parse(tsStr);
    if (!Number.isFinite(ts)) return;
    const ageWeeks = (nowMs - ts) / WEEK_MS;
    if (ageWeeks >= ttlWeeks) out.push({ filepath: r.filepath, obs: String(r?.observation ?? '').trim(), ageWeeks: Math.floor(ageWeeks) });
  });
  return out;
}
