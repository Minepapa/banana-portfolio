// 예수금 계좌 라우팅 구조적 가드 — 2026-09-03, code-reviewer 지적으로 신설.
//
// "이 계좌는 API가 정본이라 카카오/기준점+델타 재구성 루프를 안 탄다"는 결정이
// 세 파일에 각각 흩어져 있다: reconcile-nh-cash.mjs의 NH_CASH_ACCOUNTS(API로
// 직접 State/Holdings 기록), update-cash-from-ledger.mjs의 ALL_ACCOUNTS(API
// 없어 기준점+델타 재구성 유지), parse-notifications-to-vault.mjs의
// CASH_ALARM_API_EXCLUDED(카카오 예수금 알림 인식은 하되 장부엔 안 씀). 이 셋이
// 서로 어긋나면(예: 어느 계좌를 하나만 빼먹으면) 그 계좌의 예수금이 영구
// 동결되거나 반대로 원치 않게 재구성 루프를 다시 타는 조용한 사고로 이어진다
// (이 프로젝트가 예수금 이중반영 실사고를 이미 2건 겪은 지점과 같은 클래스) —
// health-watcher.test.js·vault-job-catalog-audit.test.js와 동일한 "병렬 리스트
// 갱신 누락은 프로즈가 아니라 테스트로 막는다" 원칙을 여기에도 적용한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NH_CASH_ACCOUNTS } from './reconcile-nh-cash.mjs';
import { ALL_ACCOUNTS as ANCHOR_DELTA_ACCOUNTS } from './update-cash-from-ledger.mjs';
import { CASH_ALARM_API_EXCLUDED } from './parse-notifications-to-vault.mjs';

// 이 6계좌 밖에 새 NH/KIS 계좌가 생기면(신규 계좌 개설 등) 이 테스트가 실패해
// 그 계좌를 어느 쪽 라우팅에 넣을지 명시적으로 정하게 만든다 — 조용히 어느
// 쪽에도 안 걸리는 계좌가 생기는 걸 막는다. IRP는 reconcile-irp.mjs가 API로
// 직접 State/Holdings에 쓰는 별도 경로라 이 세 상수 어디에도 없는 게 맞다.
const KNOWN_ACCOUNTS_EXCLUDING_IRP = ['위탁', 'CMA', '금현물', 'ISA', '연금저축'];

test('[핵심 안전장치] NH_CASH_ACCOUNTS와 ALL_ACCOUNTS(기준점+델타 재구성 대상)는 서로 겹치지 않는다', () => {
  const overlap = ANCHOR_DELTA_ACCOUNTS.filter((a) => NH_CASH_ACCOUNTS.has(a));
  assert.deepEqual(overlap, [], `기준점+델타 재구성과 API 직접기록이 동시에 도는 계좌: ${overlap.join(', ')}`);
});

test('[핵심 안전장치] NH_CASH_ACCOUNTS ∪ ALL_ACCOUNTS가 IRP를 제외한 5계좌를 정확히 덮는다(빠뜨린 계좌 없음)', () => {
  const covered = new Set([...NH_CASH_ACCOUNTS, ...ANCHOR_DELTA_ACCOUNTS]);
  assert.deepEqual([...covered].sort(), [...KNOWN_ACCOUNTS_EXCLUDING_IRP].sort());
});

test('[핵심 안전장치] CASH_ALARM_API_EXCLUDED(카카오 예수금 제외)는 NH_CASH_ACCOUNTS의 부분집합이어야 한다', () => {
  // API로 직접 커버 안 되는 계좌를 실수로 여기 넣으면 그 계좌 예수금 기록이
  // 카카오·API 양쪽 다 없이 영구 유실된다.
  for (const account of CASH_ALARM_API_EXCLUDED) {
    assert.ok(NH_CASH_ACCOUNTS.has(account), `${account}는 NH_CASH_ACCOUNTS에 없는데 카카오 예수금 파싱에서 제외됨 — 예수금 기록이 아예 안 남음`);
  }
});
