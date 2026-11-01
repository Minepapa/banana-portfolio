// 하루 소비 요약의 결제마다 화면용 칸 셋을 붙인다(2026-11-01, 올림푸스 헤르메스 방 — 제우스 요청, 새 볼트 경로 없음).
// - instrument: 카드 이름. 소비 설정 cardMap(알림 카드사 + 카드번호 일부 → 결제수단)에서 찾는다. 모르면 null.
// - fixedCost: 고정비 이름. 소비 설정 fixedCosts의 가맹점 키·카드가 맞으면. 결제일(dayFrom~dayTo)은 판정에 쓰지 않는다 —
//   고정비는 항목 자체로 정하고 날짜는 그 근처에 나간다는 참고값이다(오너 2026-11-01). 하나카드 자동납부 알림은 카드번호가
//   없어서(마스크 없음) 카드사가 그 고정비 카드의 카드사와 같으면 같은 카드로 본다.
// - categoryGuess: { category, subcategory, via } 또는 null. 알림 분류는 거의 '일반'이라 화면 분류로 못 쓴다.
//   오너 지정(merchantCategories) → 지난 뱅크샐러드 같은 가맹점의 가장 많은 분류(spending-tables.categoryFor) 순.
//   달을 마감하면 월 정본(Monthly)의 뱅크샐러드 분류가 정답이다. 이 값은 하루 화면용 짐작이다.
// 설정이 깨졌거나 뱅크샐러드 자료가 없으면 그 칸만 null로 두고 요약은 계속 쓴다(일일 경로는 월간 칸 오류로 멈추지 않는다).
// 대신 problems에 무엇을 못 읽었는지 남겨 잡 로그로 드러낸다(조용히 null로 바뀌지 않게).
// 요약을 쓰는 길은 writeDailySummary 하나다(수집 잡·아르고스 전달·재생성 도구). 길마다 따로 쓰면 보강 칸이 지워진다.
import { existsSync, readdirSync, readFileSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { validateSpendingSettings } from './spending-settings.mjs';
import { buildMerchantIndex, categoryFor, normalizeMerchant, readBanksaladTransactions } from './spending-tables.mjs';
import { withLock, writeAtomic } from './state-writer.mjs';

// 보강 규칙 판. 요약의 enrichmentVersion이 이보다 낮거나 없으면 수집 잡이 그날 요약을 다시 계산한다.
// 2(2026-11-01): 고정비 판정에서 결제일 창을 뺐다(오너 지시). 판정 규칙을 바꾸면 이 번호를 올린다.
export const ENRICHMENT_VERSION = 2;

// 가맹점 키가 이보다 짧으면 포함 비교에서 우연히 맞는다(spending-settings MIN_MERCHANT_KEY와 같은 값).
const MIN_KEY = 3;

export const EMPTY_ENRICHMENT = { cards: new Map(), fixedCosts: [], overrides: {}, index: new Map(), problems: [] };

// 칸마다 따로 검사한다. 고정비 한 줄 오타로 카드 표·오너 분류까지 버리지 않게.
const SECTIONS = ['cardMap', 'fixedCosts', 'merchantCategories'];

export function loadEnrichment(spendingDir) {
  const problems = [];
  let raw = {};
  try {
    const path = join(spendingDir, 'settings.json');
    if (existsSync(path)) raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch { problems.push('settings'); }
  const settings = {};
  for (const key of SECTIONS) {
    if (raw?.[key] === undefined) continue;
    try { settings[key] = validateSpendingSettings({ [key]: raw[key] })[key]; }
    catch { problems.push(key); }
  }
  let index = new Map();
  try { index = buildMerchantIndex(readBanksaladTransactions(spendingDir).transactions); }
  catch { problems.push('banksalad'); }
  const cards = new Map((settings.cardMap ?? []).map((entry) => [`${entry.card}|${entry.mask}`, entry.instrument]));
  const brands = new Map((settings.cardMap ?? []).map((entry) => [entry.instrument, entry.card]));
  const fixedCosts = (settings.fixedCosts ?? []).map((entry) => ({ ...entry, key: normalizeMerchant(entry.merchant),
    brand: brands.get(entry.instrument) ?? null }));
  const overrides = Object.fromEntries((settings.merchantCategories ?? []).map((entry) => [normalizeMerchant(entry.merchant),
    { category: entry.category, subcategory: entry.subcategory ?? null }]));
  return { cards, fixedCosts, overrides, index, problems };
}

// 가장 늦게 끝나는 뱅크샐러드 내보내기 폴더(spending-tables.readBanksaladTransactions와 같은 기준, 파일은 읽지 않는다).
function latestBanksaladReport(spendingDir) {
  const root = join(spendingDir, 'Banksalad');
  if (!existsSync(root)) return null;
  const folder = readdirSync(root).filter((name) => /^\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}$/.test(name)
    && existsSync(join(root, name, 'classified-report.json'))).sort((a, b) => a.slice(11).localeCompare(b.slice(11))).at(-1);
  return folder ? join(root, folder, 'classified-report.json') : null;
}

// 요약을 다시 계산해야 하는 바깥 입력(설정·가장 늦은 뱅크샐러드 분류 결과)의 마지막 수정 시각. 없으면 0.
// 동기화로 시각이 미래로 온 파일은 지금으로 자른다. 그 시각이 지날 때까지는 회차마다 다시 계산하지만
// (상한 MAX_SUMMARY_RECOVERIES), 시각이 지난 뒤 그 설정 변경이 영영 빠지는 일은 막는다.
export function enrichmentMtime(spendingDir, now = Date.now()) {
  const paths = [join(spendingDir, 'settings.json')];
  try {
    const report = latestBanksaladReport(spendingDir);
    if (report) paths.push(report);
  } catch { /* 뱅크샐러드 폴더를 못 읽어도 원문 요약 복구는 막지 않는다. */ }
  return Math.min(now, Math.max(0, ...paths.filter((path) => existsSync(path)).map((path) => statSync(path).mtimeMs)));
}

// 하루 요약을 쓰는 유일한 길. 원문 → 요약 잠금 순서(수집 잡과 같음)를 지키고, 같은 내용이면 다시 쓰지 않는다.
// stamp(보강 입력을 읽기 직전 시각)로 요약 수정 시각을 맞춘다: 읽은 뒤 바뀐 설정·원문은 요약보다 새로워
// 다음 회차가 다시 계산한다. 내용이 같아도 시각은 맞춰 다음 회차 후보에서 빠지게 한다. 반환: 내용을 새로 썼는지.
export async function writeDailySummary(date, { spendingDir, enrichment, stamp = new Date(), read, rawPath, summaryPath }) {
  return withLock(rawPath, () => withLock(summaryPath, () => {
    const content = `${JSON.stringify(read(date, { spendingDir, enrichment }), null, 2)}\n`;
    const changed = !existsSync(summaryPath) || readFileSync(summaryPath, 'utf8') !== content;
    if (changed) writeAtomic(summaryPath, content);
    utimesSync(summaryPath, stamp, stamp);
    return changed;
  }));
}

export function enrichEntry(entry, given) {
  const enrichment = given ?? EMPTY_ENRICHMENT;
  if (entry.status !== 'expense') return { instrument: null, fixedCost: null, categoryGuess: null };
  const instrument = enrichment.cards.get(`${entry.card}|${entry.cardMask ?? entry.cardLast4}`) ?? null;
  const key = normalizeMerchant(entry.merchant);
  // 긴 가맹점 키부터 본다. 키가 가맹점 이름 안에 들어 있어야 한다(spending_month assign_fixed와 같은 한 방향). 결제 하나는 고정비 하나다.
  const fixed = key.length >= MIN_KEY ? [...enrichment.fixedCosts]
    .sort((a, b) => b.key.length - a.key.length || a.name.localeCompare(b.name))
    .find((cost) => cost.key.length >= MIN_KEY && key.includes(cost.key)
      // 카드번호가 없는 알림(하나 자동납부)만 카드사로 대신 맞춘다. 번호가 있는데 표에 없는 카드는 다른 카드다.
      && (instrument ? instrument === cost.instrument
        : !(entry.cardMask ?? entry.cardLast4) && Boolean(entry.card) && entry.card === cost.brand)) : null;
  // 오너 지정은 알림 가맹점 이름에 앞뒤가 붙어도("NICE_주차장 나이스인프라") 포함으로 찾는다. 긴 키 먼저.
  const ownerKey = key.length >= MIN_KEY ? Object.keys(enrichment.overrides).filter((other) => other.length >= MIN_KEY
    && (key.includes(other) || other.includes(key))).sort((a, b) => b.length - a.length || a.localeCompare(b))[0] : null;
  const guess = ownerKey ? { ...enrichment.overrides[ownerKey], via: 'owner' } : categoryFor(entry.merchant, enrichment.index);
  return { instrument, fixedCost: fixed?.name ?? null,
    categoryGuess: guess ? { category: guess.category, subcategory: guess.subcategory ?? null, via: guess.via } : null };
}
