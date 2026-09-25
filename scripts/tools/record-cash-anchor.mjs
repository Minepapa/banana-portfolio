#!/usr/bin/env node
/**
 * 예수금 수동 앵커 기록 — 오너가 앱에서 직접 확인한 잔고를 CashEvent로 즉시 기록.
 *
 * 왜(2026-09-03 신설): 연금저축은 API도 카카오 자동알림도 없는 유일한 계좌라
 * (Strategy 문서·update-cash-from-ledger.mjs 헤더 참고), 매월 급여 연동 자동입금
 * (알림 없음) 등으로 기준점+델타 계산이 실제 잔고와 어긋나면 오너가 앱에서 확인한
 * 값을 수동으로 넣어줘야만 최신화된다. 지금까지는 이 작업을 매번 즉석 스크립트로
 * 처리했는데(재사용 가능한 도구가 없었음), 텔레그램 세션이 이 임시 작업을 시도하다
 * "구현 금지" 가드에 걸린 사고(2026-09-03)를 계기로 재사용 가능한 CLI로 분리한다 —
 * 이제 텔레그램 세션도 "이미 있는 운영 스크립트 실행"으로 안전하게 돌릴 수 있다
 * (CLAUDE.md "텔레그램 세션 구현 금지" 규칙은 새 코드 작성만 막지, 기존 스크립트
 * 실행은 막지 않는다).
 *
 * account는 실제로는 거의 항상 연금저축이지만(유일한 수동 계좌), 미래에 다른
 * 계좌의 API 경로가 일시적으로 깨졌을 때도 같은 도구로 수동 보정할 수 있게 특정
 * 계좌명으로 하드코딩하지 않는다 — buildCashEventRecord를 그대로 재사용해
 * update-cash-from-ledger.mjs가 다음 실행에서 이 값을 기준점으로 그대로 읽는다
 * (신규 로직 없음, 기존 예수금앵커 파이프라인 그대로 재사용).
 *
 * ⚠️ 예외(2026-09-11 신설) — ISA는 update-cash-from-ledger.mjs의 FROZEN_ANCHORS에
 * 앵커가 코드 상수로 고정돼 있어(배당누락 실사고 근본수정, 그 파일 헤더 참고) 이
 * 도구로 CashEvent를 써도 무시된다 — main()이 그 계좌면 즉시 거부한다(조용한
 * no-op 방지). ISA 앵커를 재조정하려면 FROZEN_ANCHORS를 코드로 직접 고칠 것.
 *
 * 사용법:
 *   node scripts/tools/record-cash-anchor.mjs --account=연금저축 --balance=1079918
 *   node scripts/tools/record-cash-anchor.mjs --account=연금저축 --balance=1079918 --at="2026-09-25 14:30:00"
 *   node scripts/tools/record-cash-anchor.mjs --account=연금저축 --balance=1079918 --dry-run
 *
 * 기록 직후 실제 반영은 update-cash-from-ledger.mjs가 다음 정기 실행 때(평일 16:10)
 * 자동으로 하거나, 즉시 반영하려면 이어서 `node scripts/jobs/update-cash-from-
 * ledger.mjs`를 직접 돌리면 된다(이 스크립트가 자동으로 호출하진 않는다 — 계산
 * 로직과 원문 기록을 분리하는 이 프로젝트의 기존 원칙, parse-notifications-to-
 * vault.mjs와 동일).
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildCashEventRecord } from '../lib/ledger-vault-writer.mjs';
import { writeAtomic } from '../lib/state-writer.mjs';
import { VAULT_PATHS } from '../lib/vault-paths.mjs';
import { ALL_ACCOUNTS, FROZEN_ANCHORS, buildFlows, readVaultFiles } from '../jobs/update-cash-from-ledger.mjs';

// 앱에서 잔고 확인 후 텔레그램 전달·CLI 실행까지 걸리는 현실적인 지연을 보수적으로
// 넉넉히 덮는 값이다. 정확한 실측값은 없으므로, 운영 경험이 쌓이면 조정할 수 있다.
export const WINDOW_MINUTES = 60;
const KST_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const VALUE_OPTIONS = new Set(['account', 'balance', 'at']);

export function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([a-zA-Z-]+)=(.*)$/s);
    if (m) {
      if (!VALUE_OPTIONS.has(m[1])) throw new Error(`알 수 없는 옵션: --${m[1]}`);
      out[m[1]] = m[2];
    } else if (a.startsWith('--') && a !== '--dry-run') {
      throw new Error(`알 수 없는 옵션 형식: ${a} (값이 필요한 옵션은 --이름=값 형식으로 입력하세요)`);
    }
  }
  return out;
}

// KST 벽시계 기준 "YYYY-MM-DD HH:MM:SS" — 이 프로젝트 전체가 쓰는 관례(order-
// gate.mjs checkMarketOpen·reconcile-irp.mjs 등과 동일, UTC로 쓰면 9시간 어긋나는
// 실사고가 이미 여러 번 있었음).
export function formatKstTimestamp(timestampMs) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(timestampMs));
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

function kstNow() {
  return formatKstTimestamp(Date.now());
}

export function resolveAnchorTimestamp(at, now = kstNow) {
  if (at === undefined) return now();
  if (!KST_TIMESTAMP_RE.test(at)) {
    throw new Error('--at=YYYY-MM-DD HH:MM:SS 형식 필요(예: --at="2026-09-25 14:30:00")');
  }
  const timestampMs = kstTimestampMs(at);
  if (!Number.isFinite(timestampMs) || formatKstTimestamp(timestampMs) !== at) {
    throw new Error('--at에 존재하지 않는 날짜 또는 시각이 있습니다');
  }
  const nowMs = kstTimestampMs(now());
  if (!Number.isFinite(nowMs)) throw new Error('현재 KST 시각을 해석할 수 없습니다');
  if (timestampMs > nowMs) throw new Error('--at은 미래 시각일 수 없습니다');
  return at;
}

export function kstTimestampMs(ts) {
  const value = String(ts ?? '').trim();
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/i);
  if (iso) {
    const [, year, month, day, hour, minute, second, offset] = iso;
    const wallClockMs = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
    const wallClock = new Date(wallClockMs);
    const offsetValid = offset.toUpperCase() === 'Z' || (
      Number(offset.slice(1, 3)) <= 23 && Number(offset.slice(-2)) <= 59
    );
    if (!offsetValid || wallClock.getUTCFullYear() !== Number(year) || wallClock.getUTCMonth() !== Number(month) - 1
      || wallClock.getUTCDate() !== Number(day) || wallClock.getUTCHours() !== Number(hour)
      || wallClock.getUTCMinutes() !== Number(minute) || wallClock.getUTCSeconds() !== Number(second)) return NaN;
    return new Date(value).getTime();
  }

  const match = value.match(/^(\d{4}-\d{2}-\d{2}) (\d{1,2}):(\d{2}):(\d{2})$/);
  if (!match) return NaN;
  const [, date, hour, minute, second] = match;
  const normalized = `${date} ${hour.padStart(2, '0')}:${minute}:${second}`;
  const timestampMs = new Date(`${date}T${hour.padStart(2, '0')}:${minute}:${second}+09:00`).getTime();
  return Number.isFinite(timestampMs) && formatKstTimestamp(timestampMs) === normalized ? timestampMs : NaN;
}

export function findNearbyFlows(anchorTs, flows, windowMinutes = WINDOW_MINUTES) {
  const anchorMs = kstTimestampMs(anchorTs);
  if (!Number.isFinite(anchorMs)) throw new Error(`앵커 시각 파싱 실패: ${anchorTs}`);
  const windowMs = windowMinutes * 60 * 1000;
  const nearby = [];
  const unparseable = [];
  for (const flow of flows) {
    const flowMs = kstTimestampMs(flow.ts);
    if (!Number.isFinite(flowMs)) {
      unparseable.push(flow);
    } else if (Math.abs(flowMs - anchorMs) <= windowMs) {
      nearby.push(flow);
    }
  }
  nearby.sort((a, b) => kstTimestampMs(a.ts) - kstTimestampMs(b.ts));
  return { nearby, unparseable };
}

export function formatNearbyFlowWarning(account, ts, { nearby, unparseable }, windowMinutes = WINDOW_MINUTES) {
  if (nearby.length === 0 && unparseable.length === 0) return null;
  const details = nearby.map((flow) => {
    const sign = flow.amount >= 0 ? '+' : '-';
    return `  - ${flow.ts} ${sign}${Math.abs(flow.amount).toLocaleString()}원 (${flow.kind})`;
  });
  const lines = [];
  if (nearby.length > 0) {
    lines.push(`⚠️  ${account} 앵커 시각(${ts}) 근처 ${windowMinutes}분 이내에 흐름 ${nearby.length}건 발견 — 이 앵커 이후로 처리될지 확인하세요:`, ...details);
  }
  if (unparseable.length > 0) {
    lines.push(`⚠️ 시각 파싱 실패 ${unparseable.length}건(수동 확인 필요): ${unparseable.map((flow) => flow.ts).join(', ')}`);
  }
  lines.push('   관측 시각이 이 목록의 흐름보다 이르면 --at="YYYY-MM-DD HH:MM:SS"로 다시 기록하세요.');
  return lines.join('\n');
}

// buildFlows의 현금 계산 규칙을 그대로 재사용하되, 경고 문구에 필요한 원장 종류만
// 덧붙인다. CashEvent는 depositAmount가 있는 ISA 입금안내만 flow가 되며, 수동 앵커
// 자체에는 그 필드가 없어 buildFlows가 이미 제외하므로 여기서도 읽지 않는다.
export function buildWarnableFlows(account, { executions, dividends, fundPurchases, exchanges }) {
  const label = (flows, kind) => flows.map((flow) => ({ ...flow, kind }));
  return [
    ...label(buildFlows(account, executions, [], [], [], []), '체결'),
    ...label(buildFlows(account, [], dividends, [], [], []), '배당'),
    ...label(buildFlows(account, [], [], fundPurchases, [], []), '펀드적립'),
    ...label(buildFlows(account, [], [], [], exchanges, []), '환전'),
  ];
}

export function warnNearbyFlows(account, ts, windowMinutes = WINDOW_MINUTES) {
  const flows = buildWarnableFlows(account, {
    executions: readVaultFiles(VAULT_PATHS.facts.ledger.executions),
    dividends: readVaultFiles(VAULT_PATHS.facts.ledger.dividends),
    fundPurchases: readVaultFiles(VAULT_PATHS.facts.ledger.fundPurchases),
    exchanges: readVaultFiles(VAULT_PATHS.facts.ledger.exchanges),
  });
  const warning = formatNearbyFlowWarning(account, ts, findNearbyFlows(ts, flows, windowMinutes), windowMinutes);
  if (warning) console.warn(warning);
}

function writeAnchorRecord({ dir, filename, content }) {
  mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, filename), content);
}

// 근접흐름 점검은 보조 안전장치다. Vault 동기화 경합 등으로 실패해도 이미 검증된
// 관측 잔고 기록은 반드시 계속한다. write 주입점은 이 순서를 파일 I/O 없이 검증한다.
export function recordAnchor({ account, balance, ts, dryRun, windowMinutes = WINDOW_MINUTES, warn = warnNearbyFlows, write = writeAnchorRecord }) {
  try {
    warn(account, ts, windowMinutes);
  } catch (e) {
    console.warn(`⚠️ 근접 흐름 점검 실패(기록은 계속 진행): ${e.message}`);
  }

  const record = buildCashEventRecord({ account, balance, ts });
  const filepath = join(record.dir, record.filename);
  console.log(`  + [예수금앵커·수동] ${ts} ${account} 잔고 ${balance.toLocaleString()}원 — ${filepath}`);
  if (!dryRun) {
    write(record);
    console.log('\n✅ 기록 완료 — 실제 계산 반영은 update-cash-from-ledger.mjs 다음 실행(평일 16:10) 때 자동 적용됩니다.');
    console.log('   즉시 반영하려면: node scripts/jobs/update-cash-from-ledger.mjs');
  } else {
    console.log('\n✅ 드라이런 — 쓰기 없음');
  }
  return { account, balance, ts, filepath };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(2);
  }
  const DRY_RUN = process.argv.includes('--dry-run');

  const account = args.account?.trim();
  const balance = Number(args.balance);
  if (!account) { console.error('❌ --account=계좌명 필요(예: --account=연금저축)'); process.exit(2); }
  if (!Number.isFinite(balance) || balance < 0) { console.error('❌ --balance=잔고(0 이상 숫자) 필요'); process.exit(2); }
  // 앵커 동결 계좌 거부(2026-09-11 신설, code-reviewer 지적) — ISA는
  // update-cash-from-ledger.mjs가 FROZEN_ANCHORS 코드 상수만 보고 CashEvent를
  // 더 이상 앵커로 안 읽는다(그 파일 헤더 "ISA 앵커 설계 변경" 참고). 이 가드
  // 없이 CashEvent만 쓰고 "기록 완료" 메시지를 내보내면, 실제로는 아무 효과 없는
  // 조용한 no-op인데도 오너에게는 성공한 것처럼 보인다 — 재조정이 필요하면
  // FROZEN_ANCHORS를 코드로 직접 고치라고 명시적으로 안내한다.
  if (FROZEN_ANCHORS[account]) {
    console.error(`❌ ${account}는 앵커 동결 계좌라 이 도구로 갱신 안 됨 — scripts/jobs/update-cash-from-ledger.mjs의 FROZEN_ANCHORS.${account}를 코드로 직접 고치세요.`);
    process.exit(2);
  }
  if (!ALL_ACCOUNTS.includes(account)) {
    console.error(`❌ ${account}는 이 도구의 예수금 재계산 대상이 아님 — 유효 계좌: ${ALL_ACCOUNTS.join(', ')}.`);
    process.exit(2);
  }

  let ts;
  const nowTs = kstNow();
  try {
    ts = resolveAnchorTimestamp(args.at, () => nowTs);
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(2);
  }
  const lookbackMinutes = args.at === undefined
    ? WINDOW_MINUTES
    : Math.max(WINDOW_MINUTES, Math.ceil((kstTimestampMs(nowTs) - kstTimestampMs(ts)) / 60_000));
  recordAnchor({ account, balance, ts, dryRun: DRY_RUN, windowMinutes: lookbackMinutes });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('\n❌ 오류:', e.message); process.exit(1); });
}
