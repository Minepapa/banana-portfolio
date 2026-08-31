import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDepartmentMessage, formatFactsMessage, parseContextConsiderations, parseReplyDecision, parseKillSwitchCommand,
  parseDepartmentCall, parseExecutionModeCommand, parseProposalModeCommand,
} from './telegram-messages.mjs';

const SEP = '─'.repeat(16);

test('formatDepartmentMessage: 부서보고+Zeus코멘트를 한 메시지로 합침(오너 확정 형식)', () => {
  const msg = formatDepartmentMessage({ departmentLabel: '투자전략실 Athena', body: '리밸런싱 제안입니다.', zeusComment: '승인합니다.' });
  assert.equal(msg, `[투자전략실 Athena]\n${SEP}\n리밸런싱 제안입니다.\n\n[Zeus] 승인합니다.`);
});

test('formatDepartmentMessage: zeusComment 없으면 부서보고만', () => {
  const msg = formatDepartmentMessage({ departmentLabel: '운영실 Hermes', body: '예수금 확인 결과입니다.' });
  assert.equal(msg, `[운영실 Hermes]\n${SEP}\n예수금 확인 결과입니다.`);
});

// 2026-08-23 — 대괄호 태그(상태 표시, 이모지 대체) 추가.
test('[막아야 함] formatDepartmentMessage: tag를 넘기면 부서 헤더 앞에 대괄호로 붙는다', () => {
  const msg = formatDepartmentMessage({ departmentLabel: '퀀트전략실 Kairos', body: '체결 취소됨.', tag: '취소' });
  assert.equal(msg, `[취소] [퀀트전략실 Kairos]\n${SEP}\n체결 취소됨.`);
});

test('formatDepartmentMessage: tag 안 넘기면(기본값) 태그 없이 부서 헤더만', () => {
  const msg = formatDepartmentMessage({ departmentLabel: '운영실 Hermes', body: '내용' });
  assert.doesNotMatch(msg, /^\[[가-힣]+\] \[운영실/);
});

test('formatFactsMessage: 사실→맥락→생각해볼 점 3단 구조(2026-08-31 확장 — 숫자만 던지지 말고 왜 중요한지·뭘 고민할지까지)', () => {
  const msg = formatFactsMessage({
    departmentLabel: '투자전략실 Athena',
    facts: ['리츠 갭 -1.98%p(밴드 이탈)', '연금저축 누적현금 962,000원'],
    context: '리츠 비중이 목표 대비 부족해 연금저축 내 후보 중 TIGER 리츠부동산인프라로 배분을 제안합니다.',
    considerations: ['지금 배분할지, 다음 현금 유입까지 기다릴지', '리츠 대신 국내주식 갭부터 메울지'],
  });
  assert.equal(
    msg,
    `[투자전략실 Athena]\n${SEP}\n· 리츠 갭 -1.98%p(밴드 이탈)\n· 연금저축 누적현금 962,000원\n\n리츠 비중이 목표 대비 부족해 연금저축 내 후보 중 TIGER 리츠부동산인프라로 배분을 제안합니다.\n\n[생각해볼 점]\n· 지금 배분할지, 다음 현금 유입까지 기다릴지\n· 리츠 대신 국내주식 갭부터 메울지`,
  );
});

test('formatFactsMessage: context·considerations 둘 다 없으면 사실만(LLM 없는 순수 운영 알림, 또는 조용한 날 LLM 생략)', () => {
  const msg = formatFactsMessage({ departmentLabel: '운영실 Hermes', facts: ['잡 A가 조용함', '잡 B가 조용함'] });
  assert.equal(msg, `[운영실 Hermes]\n${SEP}\n· 잡 A가 조용함\n· 잡 B가 조용함`);
});

test('formatFactsMessage: considerations 없이 context만 있어도 됨(2단 구조 그대로 허용)', () => {
  const msg = formatFactsMessage({ departmentLabel: '운영실 Hermes', facts: ['사실1'], context: '맥락문단' });
  assert.equal(msg, `[운영실 Hermes]\n${SEP}\n· 사실1\n\n맥락문단`);
});

test('formatFactsMessage: considerations가 빈 배열이면(마커는 있었지만 항목 없음) [생각해볼 점] 섹션 자체를 안 붙임', () => {
  const msg = formatFactsMessage({ departmentLabel: '운영실 Hermes', facts: ['사실1'], context: '맥락문단', considerations: [] });
  assert.equal(msg, `[운영실 Hermes]\n${SEP}\n· 사실1\n\n맥락문단`);
});

test('formatFactsMessage: zeusComment까지 있으면 맨 뒤에 붙음', () => {
  const msg = formatFactsMessage({
    departmentLabel: '투자전략실 Athena', facts: ['사실1'], context: '맥락문단', considerations: ['고민점1'], zeusComment: '승인',
  });
  assert.equal(msg, `[투자전략실 Athena]\n${SEP}\n· 사실1\n\n맥락문단\n\n[생각해볼 점]\n· 고민점1\n\n[Zeus] 승인`);
});

test('formatFactsMessage: facts 없어도(빈 배열) 헤더+구분선+빈 줄만 남고 안 터짐', () => {
  const msg = formatFactsMessage({ departmentLabel: '운영실 Hermes', facts: [] });
  assert.equal(msg, `[운영실 Hermes]\n${SEP}\n`);
});

test('[막아야 함] formatFactsMessage: tag를 넘기면 부서 헤더 앞에 대괄호로 붙는다', () => {
  const msg = formatFactsMessage({ departmentLabel: '투자전략실 Athena', facts: ['사실1'], tag: '제안' });
  assert.equal(msg, `[제안] [투자전략실 Athena]\n${SEP}\n· 사실1`);
});

// parseContextConsiderations — LLM 응답을 formatFactsMessage의 context·considerations
// 계약으로 분리(2026-08-31 신설). 각 잡 프롬프트가 [맥락]·[생각해볼 점] 마커로 응답을
// 나누도록 지시하는 게 전제.
test('parseContextConsiderations: [맥락]·[생각해볼 점] 두 마커로 정확히 분리', () => {
  const text = '[맥락]\n리츠 비중이 목표 대비 부족합니다.\n\n[생각해볼 점]\n· 지금 배분할지 기다릴지\n· 다른 자산군부터 메울지';
  const { context, considerations } = parseContextConsiderations(text);
  assert.equal(context, '리츠 비중이 목표 대비 부족합니다.');
  assert.deepEqual(considerations, ['지금 배분할지 기다릴지', '다른 자산군부터 메울지']);
});

test('parseContextConsiderations: "- " 불릿도 "· "와 동일하게 벗겨냄', () => {
  const text = '[맥락]\n맥락문단\n\n[생각해볼 점]\n- 고민점1\n- 고민점2';
  const { considerations } = parseContextConsiderations(text);
  assert.deepEqual(considerations, ['고민점1', '고민점2']);
});

test('parseContextConsiderations: [생각해볼 점] 마커가 없으면(형식 위반) 전체를 context로 보존, considerations는 null(내용 손실 없이 폴백)', () => {
  const text = '리츠 비중이 목표 대비 부족합니다. 배분을 고려해보세요.';
  const { context, considerations } = parseContextConsiderations(text);
  assert.equal(context, text);
  assert.equal(considerations, null);
});

test('parseContextConsiderations: 빈 입력이면 둘 다 null(안 터짐)', () => {
  assert.deepEqual(parseContextConsiderations(''), { context: null, considerations: null });
  assert.deepEqual(parseContextConsiderations(undefined), { context: null, considerations: null });
});

// 코드리뷰 지적(2026-08-31, MEDIUM 2건) 재발 방지 회귀 테스트

test('[막아야 함] parseContextConsiderations: 모델이 서두 인사말을 붙여도 [맥락] 마커가 결과에 안 남음', () => {
  const text = '알겠습니다.\n\n[맥락]\n리츠 비중이 부족합니다.\n\n[생각해볼 점]\n- 배분할지 기다릴지';
  const { context } = parseContextConsiderations(text);
  assert.equal(context, '리츠 비중이 부족합니다.');
  assert.doesNotMatch(context, /\[맥락\]/);
});

test('[막아야 함] parseContextConsiderations: 한 항목이 줄바꿈으로 두 줄에 걸쳐도 불릿 1개로 합쳐짐(줄바꿈 자체를 새 항목으로 오인 안 함)', () => {
  const text = '[맥락]\n맥락\n\n[생각해볼 점]\n- 아주 긴 항목인데\n  두 번째 줄로 넘어감\n- 두번째';
  const { considerations } = parseContextConsiderations(text);
  assert.deepEqual(considerations, ['아주 긴 항목인데 두 번째 줄로 넘어감', '두번째']);
});

test('parseContextConsiderations: "•" 불릿도 인식', () => {
  const text = '[맥락]\n맥락\n\n[생각해볼 점]\n• 고민점1';
  const { considerations } = parseContextConsiderations(text);
  assert.deepEqual(considerations, ['고민점1']);
});

test('parseContextConsiderations: 모델이 "빈 채로 둬라" 지시를 안 지키고 "없음"류 채움말만 쓰면 저정보 불릿 대신 null', () => {
  const text = '[맥락]\n맥락\n\n[생각해볼 점]\n- 없음';
  const { considerations } = parseContextConsiderations(text);
  assert.equal(considerations, null);
});

test('parseContextConsiderations: [맥락]은 있는데 [생각해볼 점]이 없으면(부분 형식 위반) 마커 이후 텍스트를 context로, considerations는 null', () => {
  const text = '[맥락]\n리츠 비중이 부족합니다.';
  const { context, considerations } = parseContextConsiderations(text);
  assert.equal(context, '리츠 비중이 부족합니다.');
  assert.equal(considerations, null);
});

test('parseContextConsiderations: [생각해볼 점] 섹션이 비어있으면(프롬프트 지시대로 "빈 채로 둠") considerations는 null', () => {
  const text = '[맥락]\n지금 비중이 적절합니다.\n\n[생각해볼 점]';
  const { context, considerations } = parseContextConsiderations(text);
  assert.equal(context, '지금 비중이 적절합니다.');
  assert.equal(considerations, null);
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

// 최종 확정(오너, 2026-08-12) — "정지"/"해제"는 일상 대화에 흔한 단어라 오작동 위험이
// 있어 "실전전환"/"섀도우전환"과 같은 원칙(목적 전용 복합어)으로 "긴급정지"/"정지해제"로
// 교체. STOP/stop은 영문 명령으로 유지.
test('parseKillSwitchCommand: "긴급정지"/"STOP" → activate', () => {
  assert.equal(parseKillSwitchCommand('긴급정지'), 'activate');
  assert.equal(parseKillSwitchCommand('STOP'), 'activate');
  assert.equal(parseKillSwitchCommand('stop'), 'activate');
});

test('parseKillSwitchCommand: "정지해제" → deactivate', () => {
  assert.equal(parseKillSwitchCommand('정지해제'), 'deactivate');
});

test('[막아야 함] parseKillSwitchCommand: 캐주얼한 문장 속 단어·옛 단일단어("정지"/"해제")는 더 이상 명령으로 인정 안 함(정확일치만)', () => {
  assert.equal(parseKillSwitchCommand('오늘 장 긴급정지될까?'), null);
  assert.equal(parseKillSwitchCommand('그만 stop 하자'), null);
  assert.equal(parseKillSwitchCommand('정지'), null); // 옛 단일단어 — 더 이상 인정 안 함
  assert.equal(parseKillSwitchCommand('해제'), null); // 옛 단일단어 — 더 이상 인정 안 함
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

test('parseProposalModeCommand: "제안금지" → blocked, "제안요청" → allowed', () => {
  assert.equal(parseProposalModeCommand('제안금지'), 'blocked');
  assert.equal(parseProposalModeCommand('제안요청'), 'allowed');
});

test('[막아야 함] parseProposalModeCommand: 캐주얼한 문장 속 언급은 명령으로 인정 안 함(정확일치만)', () => {
  assert.equal(parseProposalModeCommand('이제 제안금지 좀 시켜줘'), null);
  assert.equal(parseProposalModeCommand('제안'), null);
  assert.equal(parseProposalModeCommand(''), null);
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
