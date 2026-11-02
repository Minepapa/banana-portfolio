// 전략 가동 스위치 — 결정 `전략-가동`(2026-11-01 오너 지시).
//
// 자산분배는 이 스위치 대상이 아니다. 자산분배 주문 경로(place-nh-direct-order 등)는 이
// 모듈을 import하지 않는다 — strategy-switch.test.js가 import 그래프로 강제한다. 그 밖의
// 전략은 전략별로 켜고 끄며, 꺼진 전략은 신호 계산·주문·보호주문 점검·전용 시세 갱신을
// 하지 않고 경보·브리핑·리포트에서도 빠진다.
//
// 전역 킬스위치(State/KillSwitch)·체결모드(State/ExecutionMode)와는 다른 장치다. 그 둘은
// 자산분배 주문까지 막는 비상 장치라 전략을 끄는 데 쓰지 않는다.
//
// 정본은 결정 문서의 머리말 `strategies` 칸 하나다(새 볼트 경로를 만들지 않는다).
//   strategies: '{"breakout": "on"}'   (targetAllocation과 같은 홑따옴표 JSON 문자열)
//   strategies: {"breakout": "on"}     (따옴표 없는 JSON도 읽는다)
// 값이 정확히 소문자 'on'일 때만 켜진다. 칸이 없거나·JSON이 아니거나·값이 'ON'·'true'·true
// 같은 다른 값이거나·문서를 못 읽으면 전부 꺼짐이다(fail-closed). 다시 켜는 것은 오너
// 지시로만 하므로, 애매하면 끄는 쪽이 안전하다.
//
// 새 전략을 추가할 때는 STRATEGIES·STRATEGY_LABELS·STRATEGY_JOBS·STRATEGY_ENTRYPOINTS에
// 함께 넣는다. 테스트가 이름에 전략 표식이 붙은 잡·도구가 이 목록에 다 들어 있는지와,
// 목록의 진입점이 꺼진 상태에서 아무 네트워크·자식 프로세스 호출 없이 끝나는지를 확인한다.
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { resolveDecision } from './decision-resolver.mjs';
import { parseFrontmatter } from './vault-frontmatter.mjs';

export const STRATEGY_DECISION_KEY = '전략-가동';
export const STRATEGIES = ['breakout'];
export const STRATEGY_LABELS = { breakout: '돌파매매' };

// 전략별 launchd 잡 이름(run.sh case 라벨). health-watcher의 '실행 없음' 경보에서 거르는 데 쓴다.
// EXPECTED_INTERVALS_MS는 그대로 두고 여기서 거르므로, 다시 켜면 감시가 저절로 돌아온다.
export const STRATEGY_JOBS = {
  breakout: [
    'update-breakout-price-cache',
    'daily-breakout-signal-scan',
    'place-breakout-fallback-entry',
    'reconcile-breakout-protection',
    'execute-quant',
  ],
};

// 전략별 진입점(저장소 루트 기준 경로). 각 파일의 main() 첫 줄이 stopIfStrategyOff를 부른다.
// 주간 보고 스케줄(weekly-schedule-summary SCHEDULE의 script)도 이 목록의 파일 이름으로 거른다.
export const STRATEGY_ENTRYPOINTS = {
  breakout: [
    'scripts/jobs/update-breakout-price-cache.mjs',
    'scripts/jobs/daily-breakout-signal-scan.mjs',
    'scripts/jobs/place-breakout-fallback-entry.mjs',
    'scripts/jobs/reconcile-breakout-protection.mjs',
    'scripts/tools/execute-quant-proposal.mjs',
    'scripts/tools/create-quant-proposal.mjs',
    'scripts/tools/place-breakout-entry-order.mjs',
    'scripts/tools/retry-breakout-protection.mjs',
    'scripts/tools/breakout-watchlist-preview.mjs',
    'scripts/tools/watch-price-and-propose.mjs',
  ],
};

// stopIfStrategyOff(openPositionsDir)가 던지는 오류의 code. 호출측이 원문 대신 고정 문구로 경보하는 데 쓴다.
export const STRATEGY_OFF_OPEN_POSITIONS = 'STRATEGY_OFF_OPEN_POSITIONS';

// 칸이 아예 없는 것은 '끈 상태'로 본다(지금 결정 문서). 그 밖의 읽기 실패는 고장이다.
const FIELD_MISSING = 'strategies 칸이 없습니다';

// 머리말 strategies 칸을 객체로 읽는다. 형식이 어긋나면 throw — 호출측이 꺼짐으로 처리한다.
function parseStrategiesField(raw) {
  if (raw === undefined || raw === null || raw === '') throw new Error(FIELD_MISSING);
  if (typeof raw !== 'string') throw new Error('strategies 칸이 JSON 문자열이 아닙니다');
  let text = raw.trim();
  // decision-resolver가 targetAllocation에만 하는 홑따옴표 벗기기를 이 칸에도 똑같이 한다.
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) text = text.slice(1, -1).replace(/''/g, "'");
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('strategies 칸이 JSON 객체가 아닙니다');
  return parsed;
}

// 꺼짐 사유까지 함께 돌려준다. 조용히 꺼지지 않도록 잡 로그(=하트비트 detail)에 사유를 남기기 위함이다.
// fault: 칸이 없는 게 아니라 문서를 못 읽었거나(0개·2개·예외) 형식이 깨진 경우 — health-watcher가 경보한다.
function readSwitches(resolve) {
  let field = null;
  let reason = null;
  let fault = false;
  try {
    field = parseStrategiesField(resolve(STRATEGY_DECISION_KEY).frontmatter?.strategies);
  } catch (error) {
    reason = `결정 문서 strategies 칸을 읽지 못함: ${error.message}`;
    fault = error.message !== FIELD_MISSING;
  }
  const switches = {};
  for (const key of STRATEGIES) {
    switches[key] = field !== null && Object.hasOwn(field, key) && field[key] === 'on';
  }
  return { switches, reason, fault };
}

// { breakout: true|false, ... } — 알려진 전략 전부에 대해 켜짐 여부.
export function strategySwitches({ resolve = resolveDecision } = {}) {
  return readSwitches(resolve).switches;
}

// 스위치 값과 함께 읽기 고장 여부·사유. 고장이어도 switches는 전부 꺼짐이다(fail-closed).
export function strategySwitchStatus({ resolve = resolveDecision } = {}) {
  return readSwitches(resolve);
}

// 모르는 전략 이름도 꺼짐이다(오타가 켜짐으로 읽히지 않게).
export function isStrategyOn(strategyKey, { resolve = resolveDecision } = {}) {
  if (!STRATEGIES.includes(strategyKey)) return false;
  return readSwitches(resolve).switches[strategyKey] === true;
}

// 꺼진 전략의 launchd 잡 이름 집합. switches는 strategySwitches()의 결과.
export function switchedOffJobs(switches) {
  return new Set(STRATEGIES.filter((key) => switches?.[key] !== true).flatMap((key) => STRATEGY_JOBS[key] ?? []));
}

// 꺼진 전략의 진입점 파일 이름(basename) 집합.
export function switchedOffScripts(switches) {
  return new Set(STRATEGIES.filter((key) => switches?.[key] !== true)
    .flatMap((key) => (STRATEGY_ENTRYPOINTS[key] ?? []).map((path) => basename(path))));
}

// 사람이 읽는 상태 줄. 브리핑·리포트에서 꺼진 전략을 뺀 자리에 남기는 한 줄도 이것을 쓴다.
export function describeStrategySwitches(switches) {
  return STRATEGIES.map((key) => `· ${STRATEGY_LABELS[key] ?? key}: ${switches?.[key] === true
    ? '켜짐' : `꺼짐(결정 ${STRATEGY_DECISION_KEY})`}`);
}

// 포지션 폴더(로컬 볼트 State)에서 status '보유'인 파일 이름. 폴더가 없으면 빈 목록, 그 밖의 읽기 실패는 throw.
function listOpenPositionFiles(dir) {
  let names;
  try { names = readdirSync(dir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return names.filter((name) => name.endsWith('.md'))
    .filter((name) => parseFrontmatter(readFileSync(join(dir, name), 'utf8')).status === '보유');
}

// 전략 진입점 main()의 첫 줄에서 부른다. 꺼져 있으면 한 줄만 남기고 true를 돌려준다 —
// 호출측은 그대로 return해 정상 종료(exit 0)하고, run.sh가 하트비트를 OK로 남긴다.
// 이 함수는 결정 문서·포지션 폴더(로컬 파일)만 읽는다. 네트워크·증권사·자식 프로세스를 부르지 않는다.
//
// openPositionsDir(보호주문 유지 진입점 전용): 꺼졌는데 그 폴더에 열린('보유') 포지션이 남아 있으면 조용히
// 끝내지 않고 throw한다. 손절은 당일유효 주문이라 매일 다시 걸어야 하므로, 보유 중에 꺼지면 다음 거래일부터
// 손절 보호가 끊긴다. 결정은 꺼진 전략의 보호주문 점검을 하지 않는다고 정했으므로 대신 주문하지는 않고,
// 잡을 실패(exit≠0 → run.sh FAIL 하트비트 → 경보)로 드러내 오너가 켤지·수동 청산할지 정하게 한다.
// 폴더를 못 읽어도 보유 여부를 모르므로 같은 이유로 throw한다.
export function stopIfStrategyOff(strategyKey, { resolve = resolveDecision, log = console.log, openPositionsDir = null } = {}) {
  const { switches, reason } = readSwitches(resolve);
  if (STRATEGIES.includes(strategyKey) && switches[strategyKey] === true) return false;
  const label = STRATEGY_LABELS[strategyKey] ?? strategyKey;
  if (openPositionsDir) {
    let open;
    try { open = listOpenPositionFiles(openPositionsDir); } catch (error) {
      throw Object.assign(new Error(`${label} 전략 꺼짐인데 열린 포지션 여부를 읽지 못함(${error.message}) — 손절 보호 상태 확인 필요`,
        { cause: error }), { code: STRATEGY_OFF_OPEN_POSITIONS });
    }
    if (open.length) {
      throw Object.assign(new Error(`${label} 전략 꺼짐(결정 ${STRATEGY_DECISION_KEY})인데 열린 포지션 ${open.length}건(${open.join(', ')}) — `
        + '손절 보호주문을 다시 걸지 않으므로 오너 확인 필요(전략을 켜거나 수동 청산)'), { code: STRATEGY_OFF_OPEN_POSITIONS });
    }
  }
  log(`[건너뜀] ${label} 전략 꺼짐(결정 ${STRATEGY_DECISION_KEY}) — 조회·주문 없이 종료${reason ? ` (${reason})` : ''}`);
  return true;
}
