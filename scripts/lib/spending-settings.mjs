// 소비 설정 파일(`95_Etna/Spending/settings.json`)의 형식 검사와 갱신.
// - recipientDecisions: 오너가 확인한 송금 수취처(spending-parse가 읽는다).
// - cardMap·instrumentAliases·fixedCosts·merchantCategories: 소비 보고 2단계(Requests "소비 보고 카드별·항목별·고정비",
//   2026-10-31 오너 확정·제우스 판단 — 고정비 목록은 새 파일 대신 이 파일의 칸). 월 점검(spending_month.py)이 읽는다.
// 값은 코드에 박지 않는다. 오너가 확정한 값을 patch 파일로 받아 이 파일에만 쓴다(도구 spending-settings.mjs).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeAtomic } from './state-writer.mjs';

export const SETTINGS_FILE = 'settings.json';
// 도구가 바꿀 수 있는 칸. recipientDecisions·investmentAccounts는 다른 경로로 관리한다.
export const PATCHABLE_KEYS = ['cardMap', 'instrumentAliases', 'fixedCosts', 'merchantCategories'];

const text = (value) => typeof value === 'string' && value.trim().length > 0;
const day = (value) => Number.isInteger(value) && value >= 1 && value <= 31;

function check(condition, message) {
  if (!condition) throw new Error(`소비 설정 형식 오류: ${message}`);
}

export function validateSpendingSettings(settings) {
  check(settings && typeof settings === 'object' && !Array.isArray(settings), '객체가 아님');
  const recipients = settings.recipientDecisions ?? [];
  check(Array.isArray(recipients) && !recipients.some((entry) =>
    typeof entry.bank !== 'string' || !/^\d{4}$/.test(entry.last4)
    || (entry.recipient !== undefined && !['휘영', '미네'].includes(entry.recipient))
    || (entry.status !== undefined && !['expense', 'excluded'].includes(entry.status))
    || (entry.status === undefined && entry.recipient === undefined)), 'recipientDecisions');
  const cards = settings.cardMap ?? [];
  check(Array.isArray(cards) && cards.every((entry) => text(entry.card) && text(entry.mask) && text(entry.instrument)),
    'cardMap 항목은 card·mask·instrument');
  // 같은 알림 카드가 두 결제수단을 가리키면 카드별 합계가 갈린다.
  check(new Set(cards.map((entry) => `${entry.card}|${entry.mask}`)).size === cards.length, 'cardMap 중복');
  const aliases = settings.instrumentAliases ?? [];
  check(Array.isArray(aliases) && aliases.every((entry) => text(entry.from) && text(entry.to) && entry.from !== entry.to
    && (entry.via === undefined || text(entry.via))), 'instrumentAliases 항목은 from·to(·via)');
  check(new Set(aliases.map((entry) => entry.from)).size === aliases.length, 'instrumentAliases 중복');
  // 별칭이 다시 별칭을 가리키면 묶는 순서에 따라 결과가 달라진다.
  check(!aliases.some((entry) => aliases.some((other) => other.from === entry.to)), 'instrumentAliases 연쇄');
  const fixed = settings.fixedCosts ?? [];
  check(Array.isArray(fixed) && fixed.every((entry) => text(entry.name) && text(entry.merchant) && text(entry.instrument)
    && day(entry.dayFrom) && day(entry.dayTo) && typeof entry.variable === 'boolean'),
  'fixedCosts 항목은 name·merchant·instrument·dayFrom·dayTo(1~31)·variable');
  check(new Set(fixed.map((entry) => entry.name)).size === fixed.length, 'fixedCosts 이름 중복');
  const categories = settings.merchantCategories ?? [];
  check(Array.isArray(categories) && categories.every((entry) => text(entry.merchant) && text(entry.category)
    && (entry.subcategory === undefined || text(entry.subcategory))), 'merchantCategories 항목은 merchant·category(·subcategory)');
  return settings;
}

export function settingsPath(spendingDir) {
  return join(spendingDir, SETTINGS_FILE);
}

export function readSettingsFile(spendingDir) {
  const path = settingsPath(spendingDir);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
}

// patch의 칸을 통째로 바꾼다(칸 안 항목을 섞지 않는다 — 오너 확정 목록이 곧 정본). 다른 칸은 그대로 둔다.
export function mergeSettings(current, patch) {
  check(patch && typeof patch === 'object' && !Array.isArray(patch), 'patch가 객체가 아님');
  const unknown = Object.keys(patch).filter((key) => !PATCHABLE_KEYS.includes(key));
  check(!unknown.length, `바꿀 수 없는 칸 ${unknown.join(', ')}`);
  return validateSpendingSettings({ ...current, ...patch });
}

// 반환: { changed, keys } — 내용이 같으면 쓰지 않는다(LiveSync 부담).
export function applySettingsPatch(spendingDir, patch, { write = writeAtomic } = {}) {
  const current = readSettingsFile(spendingDir);
  const next = mergeSettings(current, patch);
  const before = `${JSON.stringify(current, null, 2)}\n`;
  const after = `${JSON.stringify(next, null, 2)}\n`;
  const keys = Object.keys(patch).filter((key) => JSON.stringify(current[key]) !== JSON.stringify(next[key]));
  if (before === after) return { changed: false, keys: [] };
  write(settingsPath(spendingDir), after);
  return { changed: true, keys };
}
