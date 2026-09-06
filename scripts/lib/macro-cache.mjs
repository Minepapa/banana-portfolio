// 거시지표(fetchMacroIndicators) 공유 캐시 — 2026-09-06 신설.
//
// 배경: themis-risk-review.mjs(일요일 07:00, 무인)와 weekly-report.mjs(일요일 08:00,
// 무인)가 같은 fetchMacroIndicators()를 각자 독립 호출했는데, 실제로 같은 날 1시간
// 간격의 두 호출이 코스피·코스닥 5거래일 변화율을 서로 다르게 냈다(오너 신고 —
// Log/DevRequests/2026-09-06-weekly-report-facts-불일치-버그.md). 유력한 원인은
// krx.mjs fetchTradingDaySeries가 평일 빈 응답(진짜 휴장일 vs 일시적 미발행)을 재시도
// 없이 그대로 받아들여 "5거래일 전" 기준점이 실행마다 하루씩 밀릴 수 있었던 것 —
// 그 자체는 fetchTradingDaySeries에 재시도를 추가해 별도로 완화했다(krx.mjs 참고).
//
// 이 모듈은 그와 별개로 "같은 날 여러 무인 잡이 각자 계산해서 갈라질 가능성" 자체를
// 없앤다 — 오너 확정(2026-09-06, "그렇게 해도 돼"): 하루(KST 달력일) 한 번만 계산해
// State에 저장하고, 그날 안의 모든 소비처는 그 값을 그대로 재사용한다. 자정이 지나
// 날짜가 바뀌면 다음 호출이 자동으로 새로 계산한다(오너가 명시적으로 선택한 기준 —
// 고정 TTL이 아니라 달력일 경계).
//
// 소비처(2026-09-06 조사로 확정, scripts/ 전수 grep) — 전부 이 함수로 교체:
//   themis-risk-review.mjs(일요일 07:00) · weekly-report.mjs(일요일 08:00) ·
//   quarterly-allocation-review.mjs(분기 1회) · risk-facts.mjs(/themis 커맨드, 오너 수동).
// intraday-market-move-monitor.mjs(10분마다)는 대상 아님 — 다른 티커셋을 쓰는 별도
// 함수(fetchMacroBreaches)라 이 캐시와 무관(그 파일 헤더 주석 "회귀 위험 차단" 참고).
//
// 정확성 보장(오너 지적 — "하루 한 번 계산하는 게 정확하다는 보장은?"): 캐시가
// "일관성"만 보장하고 "정확성"까지 보장하진 않는다 — 그래서 계산 직후 이상치를
// 검사한다(아래 ANOMALY_THRESHOLD_PCT). 위 krx.mjs 재시도와 합쳐 이중 방어.
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { VAULT_PATHS } from './vault-paths.mjs';
import { buildFrontmatter, parseFrontmatter } from './vault-frontmatter.mjs';
import { writeAtomic } from './state-writer.mjs';
import { fetchMacroIndicators } from './fundamentals.mjs';

// 단일 지표의 5거래일 변화율이 이 폭을 넘으면 "이상치일 수 있음"으로 콘솔 경고만
// 남긴다(캐시 자체는 그대로 진행 — 폴백 없음 원칙상 값을 임의로 버리거나 고치지
// 않는다, 사람이 원문을 보고 판단). 실측 참고: 이번 사고에서 갈린 두 값(-4.82%·
// -1.50%)의 차이(3.3%p)보다 넓게 잡아, 정상적인 큰 변동(예: 실제 급락장)까지
// 오탐으로 매번 울리지 않게 한다.
export const ANOMALY_THRESHOLD_PCT = 12;

function kstDateStr(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(d);
}

// 캐시 파일 읽기 — 없거나·형식이 깨졌으면 null(그러면 호출부가 새로 계산). 순수함수
// (테스트에서 문자열 content로 직접 검증) — 파일 I/O 자체는 readMacroCacheFile이 담당.
export function parseMacroCache(content) {
  if (!content) return null;
  const fm = parseFrontmatter(content);
  if (!fm.asof || !fm.macroJson) return null;
  try {
    return { asof: fm.asof, macro: JSON.parse(fm.macroJson), computedAt: fm.computedAt ?? null };
  } catch {
    return null;
  }
}

function readMacroCacheFile(filepath) {
  try { return readFileSync(filepath, 'utf8'); } catch { return null; }
}

// macro 객체(fetchMacroIndicators 반환 형태) 중 |change5d|가 ANOMALY_THRESHOLD_PCT를
// 넘는 지표 이름 목록 — 순수함수. 호출부가 콘솔 경고 여부를 결정.
export function findMacroAnomalies(macro, threshold = ANOMALY_THRESHOLD_PCT) {
  return Object.entries(macro || {})
    .filter(([, o]) => o?.change5d != null && Math.abs(o.change5d) > threshold)
    .map(([key]) => key);
}

// 오늘(KST) 캐시가 있으면 그대로 재사용, 없거나 날짜가 지났으면 새로 계산해 저장.
// fetchFn/filepath/now는 테스트 주입용(기본값은 실제 fetchMacroIndicators·실제 경로·
// 현재 시각).
export async function getCachedMacroIndicators({
  now = new Date(), fetchFn = fetchMacroIndicators, filepath = VAULT_PATHS.state.macroIndicators,
} = {}) {
  const today = kstDateStr(now);
  const cached = parseMacroCache(readMacroCacheFile(filepath));
  if (cached && cached.asof === today) return cached.macro;

  const macro = await fetchFn();
  const anomalies = findMacroAnomalies(macro);
  if (anomalies.length) {
    console.warn(`⚠️ 거시지표 이상치 의심(5거래일 변화율 ±${ANOMALY_THRESHOLD_PCT}% 초과, 원문 확인 권장): ${anomalies.join(', ')}`);
  }
  mkdirSync(dirname(filepath), { recursive: true });
  writeAtomic(filepath, buildFrontmatter({ asof: today, macroJson: JSON.stringify(macro), computedAt: now.toISOString() }));
  return macro;
}
