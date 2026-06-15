#!/usr/bin/env node
/**
 * 성향관찰 시트 시드 (일회성·멱등)
 *
 * 앱 성향확인 탭은 '성향관찰' 시트를 읽는다. 앱 batchGet은 없는 탭 참조 시 배치 전체가
 * 실패하므로 배포 전 이 스크립트로 탭을 먼저 만들고 초기 성향을 적재한다.
 *
 * 시드 = ① §3 명시 핵심 성향(status=확정, 증거="명시 프로필 §3") — 앱이 §3 md를 못 읽으므로
 *         탭에서 "기존 내 성향 전체"를 보이게 함.
 *        ② 대화에서 확정된 명시 피드백(2026-06-14) — observed-behavior.md 시드 이관.
 *
 * 멱등: 시트에 이미 데이터 행이 있으면 시드를 건너뛴다(중복 방지).
 *
 * 사용법:
 *   node scripts/seed-preferences.mjs            # OAuth(대화형) 또는 SA(무인)
 *   node scripts/seed-preferences.mjs <TOKEN>    # 토큰 직접 전달
 */

import { loadEnv, getToken, hasServiceAccount, ensureSheet, getRange, appendValues, nowKST } from './lib/sheets-common.mjs';

const SHEET = '성향관찰';
const HEADER = ['날짜', '신호유형', '관찰', '증거', '§3대비', '신뢰도', '상태', '갱신시각'];

// [날짜, 신호유형, 관찰, 증거, §3대비, 신뢰도, 상태]
const SEEDS = [
  // ① §3 명시 핵심 성향 — 확정(분석의 기준)
  ['2026-06-15', '매수 성향', '단기 급락 시 저점 매수를 강하게 선호. 1회 매수 500만원 미만 적립식. 추격 매수 비선호.', '명시 프로필 §3', '일치(보강)', '높음', '확정'],
  ['2026-06-15', '매도 성향', '단기 급락 후 빠른 반등 시 차익 실현. 과열 구간 일부 익절. 소규모 손절 허용.', '명시 프로필 §3', '일치(보강)', '높음', '확정'],
  ['2026-06-15', '보유 성향', '펀더멘털 훼손 없으면 단기 변동성에 흔들리지 않고 장기 보유.', '명시 프로필 §3', '일치(보강)', '높음', '확정'],
  // ② 대화 명시 피드백 — 확정
  ['2026-06-15', '투자 철학', '펀더멘털 우선. 52주 고점·RSI 과열 같은 가격 신호만으로 익절하지 않음. 리스크 우선순위 B(논리 훼손)>D(거시)>가격.', '협업 이력 · §3 보유 원칙', '일치(보강)', '높음', '확정'],
  ['2026-06-15', '명시 피드백(분석 선호)', '일반 시장 분석이 아니라 내 포트폴리오·계좌·성향에 연결된 맞춤 분석을 요구. 일반론 시장 코멘트 거부.', '대화 2026-06-14 "단순한 시장 분석이 아니라 내 맞춤형 분석이 필요해"', '신규', '높음', '확정'],
  ['2026-06-15', '명시 피드백(데이터 신뢰)', '자산 값(가격·수량·평가액)은 항상 시트 정본을 읽고 추정·재계산 금지. 정확성 최우선.', '대화 2026-06-14 "가격이나 수량을 추정하지 말고 항상 시트의 값을 읽어"', '신규', '높음', '확정'],
  ['2026-06-15', '명시 피드백(리포트 형식)', '리포트는 가독성이 높고 데이터 나열이 아니라 분석가의 명확한 시선(입장)이 들어가야 함.', '대화 2026-06-14 "가독성을 높여야 해 / 너의 시선이 들어가야 해"', '신규', '높음', '확정'],
];

async function main() {
  loadEnv();
  console.log('🌱 성향관찰 시트 시드');
  let token = process.argv.slice(2).find(a => !a.startsWith('--'))?.trim() || null;
  console.log(token ? '✓ 토큰 인수' : (hasServiceAccount() ? '🤖 서비스 계정 인증' : '🔑 Google 인증'));
  token = await getToken(token);

  const created = await ensureSheet(token, SHEET, HEADER);
  if (!created) console.log(`   ℹ️ 탭 이미 존재: ${SHEET}`);

  const existing = await getRange(token, `${SHEET}!A2:A`);
  if (existing.length > 0) {
    console.log(`   ℹ️ 이미 ${existing.length}개 행 존재 — 시드 건너뜀(멱등)`);
    return;
  }

  const now = nowKST();
  const rows = SEEDS.map(s => [...s, now]);
  await appendValues(token, `${SHEET}!A2`, rows);
  console.log(`   ✅ 시드 ${rows.length}건 적재 (확정 성향)`);
  rows.forEach(r => console.log(`      · [${r[6]}] ${r[1]}: ${r[2].slice(0, 40)}...`));
  console.log('\n🏁 완료 — 앱 성향 탭에서 확인 가능');
}

main().catch(e => { console.error('\n❌ 오류:', e.message); process.exit(1); });
