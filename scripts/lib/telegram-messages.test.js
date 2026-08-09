import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDepartmentMessage, parseReplyDecision, parseKillSwitchCommand, parseDepartmentCall,
  parseExecutionModeCommand,
} from './telegram-messages.mjs';

test('formatDepartmentMessage: 부서보고+Zeus코멘트를 한 메시지로 합침(오너 확정 형식)', () => {
  const msg = formatDepartmentMessage({ departmentLabel: '투자전략실 Athena', body: '리밸런싱 제안입니다.', zeusComment: '승인합니다.' });
  assert.equal(msg, '[투자전략실 Athena]\n리밸런싱 제안입니다.\n\n[Zeus] 승인합니다.');
});

test('formatDepartmentMessage: zeusComment 없으면 부서보고만', () => {
  const msg = formatDepartmentMessage({ departmentLabel: '운영실 Hermes', body: '예수금 확인 결과입니다.' });
  assert.equal(msg, '[운영실 Hermes]\n예수금 확인 결과입니다.');
});

test('parseReplyDecision: "승인"이 포함되면 승인(부가 코멘트 있어도)', () => {
  assert.equal(parseReplyDecision('승인'), '승인');
  assert.equal(parseReplyDecision('승인 근데 가격 확인해줘'), '승인');
});

test('parseReplyDecision: "거부"가 포함되면 거부', () => {
  assert.equal(parseReplyDecision('거부'), '거부');
  assert.equal(parseReplyDecision('거부합니다 지금은 아닌듯'), '거부');
});

test('[막아야 함] parseReplyDecision: 승인/거부 둘 다 없으면(애매) 추정하지 않고 null', () => {
  assert.equal(parseReplyDecision('음 좀 더 생각해볼게'), null);
  assert.equal(parseReplyDecision(''), null);
});

test('[막아야 함] parseReplyDecision: 승인/거부가 둘 다 있으면(모순) 추정하지 않고 null', () => {
  assert.equal(parseReplyDecision('승인 아니 거부할래'), null);
});

test('parseKillSwitchCommand: "정지"/"STOP" → activate', () => {
  assert.equal(parseKillSwitchCommand('정지'), 'activate');
  assert.equal(parseKillSwitchCommand('STOP'), 'activate');
  assert.equal(parseKillSwitchCommand('stop'), 'activate');
});

test('parseKillSwitchCommand: "해제" → deactivate', () => {
  assert.equal(parseKillSwitchCommand('해제'), 'deactivate');
});

test('[막아야 함] parseKillSwitchCommand: 캐주얼한 문장 속 단어는 명령으로 인정 안 함(정확일치만)', () => {
  assert.equal(parseKillSwitchCommand('오늘 장 정지될까?'), null);
  assert.equal(parseKillSwitchCommand('그만 stop 하자'), null);
});

test('parseExecutionModeCommand: "실전전환" → live', () => {
  assert.equal(parseExecutionModeCommand('실전전환'), 'live');
});

test('parseExecutionModeCommand: "섀도우전환" → shadow', () => {
  assert.equal(parseExecutionModeCommand('섀도우전환'), 'shadow');
});

test('[막아야 함] parseExecutionModeCommand: 캐주얼한 문장 속 언급은 명령으로 인정 안 함(정확일치만)', () => {
  assert.equal(parseExecutionModeCommand('이제 실전전환 해도 될까?'), null);
  assert.equal(parseExecutionModeCommand('아직 섀도우전환은 이르지'), null);
  assert.equal(parseExecutionModeCommand('실전'), null);
});

test('parseDepartmentCall: "카이로스, ~" 형식 파싱', () => {
  const r = parseDepartmentCall('카이로스, 이번 달 리컨스티튜션 어때');
  assert.deepEqual(r, { department: '카이로스', message: '이번 달 리컨스티튜션 어때' });
});

test('parseDepartmentCall: 쉼표 없이 공백만 있어도 파싱', () => {
  const r = parseDepartmentCall('아테나 리밸런싱안 줘');
  assert.deepEqual(r, { department: '아테나', message: '리밸런싱안 줘' });
});

test('parseDepartmentCall: 부서명으로 시작 안 하면 null', () => {
  assert.equal(parseDepartmentCall('안녕 오늘 뭐해'), null);
});
