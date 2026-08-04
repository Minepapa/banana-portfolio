// 잡 하트비트 — v1 record-heartbeat.mjs(구글시트 "잡상태" 탭)의 Vault판.
// 순수 함수 — 실제 파일 읽기/쓰기는 호출부(scripts/jobs/record-heartbeat-vault.mjs·
// health-watcher.mjs)가 state-writer.mjs로 수행한다.
//
// v1과의 핵심 차이(docs/ARCHITECTURE-V2.md "백업·장애감지" 절): v1은 잡이 스스로
// "실패"를 보고할 때만 경보한다 — 잡이 아예 조용해지면(launchd 잡 삭제·스크립트가
// record-heartbeat 호출 전에 죽음·Mac 절전 등) 못 잡는다. v2는 독립 워처가 "이 잡이
// 기대 주기의 2배 이상 조용하다"를 별도로 감시해 그 사각을 메운다(isStale).

function yamlValue(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${s}"`;
}

function buildFrontmatter(fields) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) lines.push(`${k}: ${yamlValue(v)}`);
  lines.push('---', '');
  return lines.join('\n');
}

// 아주 단순한 "key: value" frontmatter 파서 — job-health 파일은 이 모듈이 직접 쓰므로
// 형태가 고정돼 있다(중첩 없음, buildFrontmatter의 역함수). 범용 YAML 파서가 필요하면
// 그때 라이브러리를 도입한다(지금은 과설계 방지).
export function parseFrontmatter(content) {
  const m = String(content ?? '').match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!mm) continue;
    const [, key, raw] = mm;
    if (raw === 'null') out[key] = null;
    else if (/^-?\d+(\.\d+)?$/.test(raw)) out[key] = Number(raw);
    else if (raw === 'true' || raw === 'false') out[key] = raw === 'true';
    else out[key] = raw.replace(/^"|"$/g, '').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return out;
}

// prior: 이전 State/JobHealth/<job>.md를 parseFrontmatter로 읽은 결과(없으면 null).
// v1과 동일한 규칙: OK면 연속실패 0으로 리셋, 아니면 이전값+1. 1회 실패는 조용히
// 넘어가고(일시 오류 자가복구 기대) 연속 2회 이상부터 알림 — 호출부가 이 값을 보고 판단.
export function buildJobHealthRecord({ job, status, detail = '', durationSec = null, now = new Date() }, prior = null) {
  const priorStreak = Number.isFinite(prior?.failStreak) ? prior.failStreak : 0;
  const failStreak = status === 'OK' ? 0 : priorStreak + 1;
  const lastRun = now.toISOString();
  const filename = `${job}.md`;
  const content = buildFrontmatter({
    job, lastRun, status, detail: String(detail ?? '').slice(0, 200),
    durationSec: durationSec === null ? null : Number(durationSec),
    failStreak,
  });
  return { filename, content, failStreak, shouldAlert: status !== 'OK' && failStreak >= 2 };
}

// lastRun(ISO 문자열) 기준으로 expectedIntervalMs의 2배를 넘겼으면 stale(조용해짐)로 판정.
// (docs/ARCHITECTURE-V2.md: "기대 주기(매시간)의 2배(2시간) 이상 조용하면 이상 신호")
export function isStale({ lastRun, expectedIntervalMs, now = new Date() }) {
  if (!lastRun) return true; // 기록 자체가 없으면(잡이 한 번도 안 돎) 당연히 stale
  const last = new Date(lastRun).getTime();
  if (!Number.isFinite(last)) return true; // 파싱 불가한 값도 안전하게 stale 취급
  return now.getTime() - last > expectedIntervalMs * 2;
}
