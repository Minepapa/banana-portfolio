import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyInvestmentNotification, findLedgerTwin, kstTimestamp, readArgosInvestmentNotifications,
} from './argos-notifications.mjs';
import { buildDividendRecord } from './ledger-vault-writer.mjs';
import { compareNotification, findExecutionTwin, kakaoOnly } from '../tools/argos-notification-compare.mjs';

const DIVIDEND = '[NH투자증권] 배당금 입금 안내\n종목명 : TIGER 리츠부동산인프라\n세후금액 : 15,000원\n입금일 : 2026.08.04';
const AD = '[NH투자증권] 이번 주 투자 정보 안내';
const at = (kst) => Date.parse(`${kst.replace(' ', 'T')}+09:00`);

function eventsDir(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'argos-notif-'));
  mkdirSync(join(dir, '2026'));
  writeFileSync(join(dir, '2026', '2026-08-04.jsonl'), `${lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n')}\n`);
  return dir;
}
const notif = (id, category, body, kst) => ({ id, type: 'notification.received', occurred_at: at(kst),
  payload: { sender: 'NH투자증권', category, body, postedAt: at(kst) } });

test('epoch ms를 카카오 수신함과 같은 KST 시각 문자열로 바꾼다', () => {
  assert.equal(kstTimestamp(at('2026-08-04 09:00:05')), '2026-08-04 09:00:05');
  assert.equal(kstTimestamp(Date.parse('2026-08-03T15:30:00Z')), '2026-08-04 00:30:00');
});

test('투자 분류의 알림만 읽고 깨진 줄·다른 종류·소비 알림은 건너뛴다', () => {
  const dir = eventsDir([notif('a', '투자', DIVIDEND, '2026-08-04 09:00:05'), notif('b', '소비', '결제 1,000원', '2026-08-04 09:01:00'),
    '{깨진 줄', { type: 'location.point_recorded', payload: {} }, notif('c', '투자', '', '2026-08-04 09:02:00')]);
  const items = readArgosInvestmentNotifications(dir, '2026-08-04');
  assert.deepEqual(items.map((i) => [i.id, i.ts, i.sender]), [['a', '2026-08-04 09:00:05', 'NH투자증권']]);
  assert.deepEqual(readArgosInvestmentNotifications(dir, '2026-08-05'), []);
});

test('장부에 쓸 알림만 종류를 붙이고 광고·안내는 걸러낸다', () => {
  assert.equal(classifyInvestmentNotification(DIVIDEND, '2026-08-04 09:00:05').type, '배당');
  assert.equal(classifyInvestmentNotification(AD, '2026-08-04 09:00:05'), null);
});

test('수신 시각이 몇 초 다른 같은 장부 기록을 찾고, 범위를 넘으면 다른 기록으로 본다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'argos-ledger-'));
  writeFileSync(join(dir, '2026-08-04-090001-TIGER 리츠.md'), '');
  assert.equal(findLedgerTwin('2026-08-04-090105-TIGER 리츠.md', dir), '2026-08-04-090001-TIGER 리츠.md');
  assert.equal(findLedgerTwin('2026-08-04-091001-TIGER 리츠.md', dir), null);
  assert.equal(findLedgerTwin('2026-08-04-090001-다른 종목.md', dir), null);
  assert.equal(findLedgerTwin('2026-08-04-090001-x.md', join(dir, 'none')), null);
});

test('대조: 카카오 경로가 남긴 배당은 장부 일치, 없으면 아르고스만, 광고는 걸러냄', () => {
  const ledger = mkdtempSync(join(tmpdir(), 'argos-div-'));
  const argos = { body: DIVIDEND, ts: '2026-08-04 09:00:40', sender: 'NH투자증권' };
  const dirs = { executionsDir: '/none', apiCoveredDir: '/none', ledgerDirs: { 배당: ledger } };
  assert.deepEqual(compareNotification(argos, dirs), { verdict: '아르고스만', type: '배당', twin: null });
  const kakao = buildDividendRecord(classifyInvestmentNotification(DIVIDEND, '2026-08-04 09:00:00').parsed);
  writeFileSync(join(ledger, kakao.filename), '');
  assert.deepEqual(compareNotification(argos, dirs), { verdict: '장부 일치', type: '배당', twin: kakao.filename });
  assert.deepEqual(compareNotification({ ...argos, body: AD }, dirs), { verdict: '걸러냄', sender: 'NH투자증권' });
});

test('체결 대조: 띄어쓰기 종목명은 장부 정규화로 맞추고 매수·매도·종목·수량이 정확히 같아야 한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'argos-exec-'));
  writeFileSync(join(dir, '2026-10-23-100001-매수-TIGER-미국S&P500-10-0001234.md'), '');
  writeFileSync(join(dir, '2026-10-23-100001-매수-삼성전자우-1.md'), '');
  const dirs = { executionsDir: dir, apiCoveredDir: '/none' };
  const ex = (o) => findExecutionTwin({ ts: '2026-10-23 10:00:30', tradeType: '매수', stockName: 'TIGER 미국S&P500', quantity: 10, ...o }, dirs);
  assert.equal(ex({}), '2026-10-23-100001-매수-TIGER-미국S&P500-10-0001234.md');
  assert.equal(ex({ quantity: 1 }), null);
  assert.equal(ex({ tradeType: '매도' }), null);
  assert.equal(ex({ stockName: '삼성전자', quantity: 1 }), null);
  assert.equal(ex({ stockName: '삼성전자우', quantity: '1' }), '2026-10-23-100001-매수-삼성전자우-1.md');
});

test('한 장부 기록은 한 알림에만 짝짓고, 자정을 넘는 몇 초 차이는 같은 기록으로 본다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'argos-used-'));
  writeFileSync(join(dir, '2026-10-24-000005-매수-KODEX-200-3.md'), '');
  const dirs = { executionsDir: dir, apiCoveredDir: '/none' };
  const used = new Set();
  const item = { ts: '2026-10-23 23:59:55', tradeType: '매수', stockName: 'KODEX 200', quantity: 3 };
  assert.equal(findExecutionTwin(item, dirs, used), '2026-10-24-000005-매수-KODEX-200-3.md');
  assert.equal(findExecutionTwin(item, dirs, used), null);
});

test('API 보관함은 머리말 종목명이 정확히 같고 수신 시각이 3분 안일 때만 짝짓는다', () => {
  const api = mkdtempSync(join(tmpdir(), 'argos-api-'));
  writeFileSync(join(api, 'doc1.md'), '---\nstockName: "삼성전자우"\nreceivedAt: "2026-10-23 10:00:00"\n---\n');
  writeFileSync(join(api, 'doc2.md'), '---\nstockName: "삼성전자"\nreceivedAt: "2026-10-23 10:00:10"\n---\n');
  const dirs = { executionsDir: '/none', apiCoveredDir: api };
  assert.equal(findExecutionTwin({ ts: '2026-10-23 10:01:00', tradeType: '매수', stockName: '삼성전자', quantity: 1 }, dirs), 'doc2.md');
  assert.equal(findExecutionTwin({ ts: '2026-10-23 10:30:00', tradeType: '매수', stockName: '삼성전자우', quantity: 1 }, dirs), null);
});

test('카카오만: 짝이 없는 그날 장부 기록을 세고, 체결은 NH_API 출처를 뺀다', () => {
  const exec = mkdtempSync(join(tmpdir(), 'argos-ko-'));
  writeFileSync(join(exec, '2026-10-23-100001-매수-A-1.md'), '---\nsource: "KAKAO"\n---\n');
  writeFileSync(join(exec, '2026-10-23-100002-매수-B-1.md'), '---\nsource: "NH_API"\n---\n');
  writeFileSync(join(exec, '2026-10-23-100003-매수-C-1.md'), '---\nsource: "KAKAO"\n---\n');
  writeFileSync(join(exec, '2026-10-22-100003-매수-D-1.md'), '---\nsource: "KAKAO"\n---\n');
  const used = new Set([join(exec, '2026-10-23-100003-매수-C-1.md')]);
  assert.deepEqual(kakaoOnly('2026-10-23', { 체결: exec, 배당: '/none' }, used), { 체결: 1 });
});
