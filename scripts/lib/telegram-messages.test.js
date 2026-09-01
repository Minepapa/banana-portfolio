import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDepartmentMessage, formatFactsMessage, parseDepartmentResponse, stripEmDash, parseReplyDecision, parseKillSwitchCommand,
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

test('formatFactsMessage: 결론→사실→맥락→의사결정 4단 구조(2026-09-01 오너가 직접 예시 메시지를 손으로 고쳐 확정)', () => {
  const msg = formatFactsMessage({
    departmentLabel: '투자전략실 Athena',
    facts: ['리츠 갭 -1.98%p(밴드 이탈)', '연금저축 누적현금 962,000원'],
    conclusion: '지금 배분할 필요는 없습니다.',
    context: '리츠 비중이 목표 대비 부족해 연금저축 내 후보 중 TIGER 리츠부동산인프라로 배분을 제안합니다.',
    decisions: ['지금 배분할지, 다음 현금 유입까지 기다릴지', '리츠 대신 국내주식 갭부터 메울지'],
  });
  assert.equal(
    msg,
    `[투자전략실 Athena]\n\n[결론]\n지금 배분할 필요는 없습니다.\n\n[사실]\n· 리츠 갭 -1.98%p(밴드 이탈)\n· 연금저축 누적현금 962,000원\n\n[맥락]\n리츠 비중이 목표 대비 부족해 연금저축 내 후보 중 TIGER 리츠부동산인프라로 배분을 제안합니다.\n\n[의사결정]\n· 지금 배분할지, 다음 현금 유입까지 기다릴지\n· 리츠 대신 국내주식 갭부터 메울지`,
  );
});

test('formatFactsMessage: conclusion·context·decisions 전부 없으면 [사실]만(LLM 없는 순수 운영 알림, 또는 조용한 날 LLM 생략)', () => {
  const msg = formatFactsMessage({ departmentLabel: '운영실 Hermes', facts: ['잡 A가 조용함', '잡 B가 조용함'] });
  assert.equal(msg, `[운영실 Hermes]\n\n[사실]\n· 잡 A가 조용함\n· 잡 B가 조용함`);
});

test('formatFactsMessage: decisions 없이 context만 있어도 됨(부분 구조 허용)', () => {
  const msg = formatFactsMessage({ departmentLabel: '운영실 Hermes', facts: ['사실1'], context: '맥락문단' });
  assert.equal(msg, `[운영실 Hermes]\n\n[사실]\n· 사실1\n\n[맥락]\n맥락문단`);
});

test('formatFactsMessage: decisions가 빈 배열이면(마커는 있었지만 항목 없음) [의사결정] 섹션 자체를 안 붙임', () => {
  const msg = formatFactsMessage({ departmentLabel: '운영실 Hermes', facts: ['사실1'], context: '맥락문단', decisions: [] });
  assert.equal(msg, `[운영실 Hermes]\n\n[사실]\n· 사실1\n\n[맥락]\n맥락문단`);
});

test('formatFactsMessage: zeusComment까지 있으면 맨 뒤에 붙음', () => {
  const msg = formatFactsMessage({
    departmentLabel: '투자전략실 Athena', facts: ['사실1'], conclusion: '결론문장', context: '맥락문단', decisions: ['고민점1'], zeusComment: '승인',
  });
  assert.equal(msg, `[투자전략실 Athena]\n\n[결론]\n결론문장\n\n[사실]\n· 사실1\n\n[맥락]\n맥락문단\n\n[의사결정]\n· 고민점1\n\n[Zeus] 승인`);
});

test('formatFactsMessage: facts 없어도(빈 배열) 헤더+[사실] 빈 줄만 남고 안 터짐', () => {
  const msg = formatFactsMessage({ departmentLabel: '운영실 Hermes', facts: [] });
  assert.equal(msg, `[운영실 Hermes]\n\n[사실]\n`);
});

test('[막아야 함] formatFactsMessage: tag를 넘기면 부서 헤더 앞에 대괄호로 붙는다', () => {
  const msg = formatFactsMessage({ departmentLabel: '투자전략실 Athena', facts: ['사실1'], tag: '제안' });
  assert.equal(msg, `[제안] [투자전략실 Athena]\n\n[사실]\n· 사실1`);
});

// parseDepartmentResponse — LLM 응답을 formatFactsMessage의 conclusion·context·decisions
// 계약으로 분리(2026-08-31 신설, 2026-09-01 3섹션으로 확장). 각 잡 프롬프트가 [결론]·
// [맥락]·[의사결정] 마커로 응답을 나누도록 지시하는 게 전제.
test('parseDepartmentResponse: [결론]·[맥락]·[의사결정] 세 마커로 정확히 분리', () => {
  const text = '[결론]\n배분을 보류합니다.\n\n[맥락]\n리츠 비중이 목표 대비 부족합니다.\n\n[의사결정]\n· 지금 배분할지 기다릴지\n· 다른 자산군부터 메울지';
  const { conclusion, context, decisions } = parseDepartmentResponse(text);
  assert.equal(conclusion, '배분을 보류합니다.');
  assert.equal(context, '리츠 비중이 목표 대비 부족합니다.');
  assert.deepEqual(decisions, ['지금 배분할지 기다릴지', '다른 자산군부터 메울지']);
});

test('parseDepartmentResponse: "- " 불릿도 "· "와 동일하게 벗겨냄', () => {
  const text = '[맥락]\n맥락문단\n\n[의사결정]\n- 고민점1\n- 고민점2';
  const { decisions } = parseDepartmentResponse(text);
  assert.deepEqual(decisions, ['고민점1', '고민점2']);
});

test('parseDepartmentResponse: 마커가 하나도 없으면(형식 위반) 전체를 context로 보존, 나머지는 null(내용 손실 없이 폴백)', () => {
  const text = '리츠 비중이 목표 대비 부족합니다. 배분을 고려해보세요.';
  const { conclusion, context, decisions } = parseDepartmentResponse(text);
  assert.equal(conclusion, null);
  assert.equal(context, text);
  assert.equal(decisions, null);
});

test('parseDepartmentResponse: 빈 입력이면 전부 null(안 터짐)', () => {
  assert.deepEqual(parseDepartmentResponse(''), { conclusion: null, context: null, decisions: null });
  assert.deepEqual(parseDepartmentResponse(undefined), { conclusion: null, context: null, decisions: null });
});

// 코드리뷰 지적(2026-08-31, MEDIUM 2건) 재발 방지 회귀 테스트 — 3섹션 파서에서도 유지

test('[막아야 함] parseDepartmentResponse: 모델이 서두 인사말을 붙여도 마커 앞 텍스트는 결과에 안 섞임', () => {
  const text = '알겠습니다.\n\n[결론]\n배분 보류.\n\n[맥락]\n리츠 비중이 부족합니다.\n\n[의사결정]\n- 배분할지 기다릴지';
  const { conclusion, context } = parseDepartmentResponse(text);
  assert.equal(conclusion, '배분 보류.');
  assert.equal(context, '리츠 비중이 부족합니다.');
  assert.doesNotMatch(context, /\[맥락\]|알겠습니다/);
});

test('[막아야 함] parseDepartmentResponse: 한 항목이 줄바꿈으로 두 줄에 걸쳐도 불릿 1개로 합쳐짐(줄바꿈 자체를 새 항목으로 오인 안 함)', () => {
  const text = '[맥락]\n맥락\n\n[의사결정]\n- 아주 긴 항목인데\n  두 번째 줄로 넘어감\n- 두번째';
  const { decisions } = parseDepartmentResponse(text);
  assert.deepEqual(decisions, ['아주 긴 항목인데 두 번째 줄로 넘어감', '두번째']);
});

test('parseDepartmentResponse: "•" 불릿도 인식', () => {
  const text = '[맥락]\n맥락\n\n[의사결정]\n• 고민점1';
  const { decisions } = parseDepartmentResponse(text);
  assert.deepEqual(decisions, ['고민점1']);
});

test('parseDepartmentResponse: 모델이 "빈 채로 둬라" 지시를 안 지키고 "없음"류 채움말만 쓰면 저정보 불릿 대신 null', () => {
  const text = '[맥락]\n맥락\n\n[의사결정]\n- 없음';
  const { decisions } = parseDepartmentResponse(text);
  assert.equal(decisions, null);
});

test('parseDepartmentResponse: [맥락]은 있는데 [의사결정]이 없으면(부분 형식 위반) 마커 이후 텍스트를 context로, decisions는 null', () => {
  const text = '[맥락]\n리츠 비중이 부족합니다.';
  const { context, decisions } = parseDepartmentResponse(text);
  assert.equal(context, '리츠 비중이 부족합니다.');
  assert.equal(decisions, null);
});

test('parseDepartmentResponse: [의사결정] 섹션이 비어있으면(프롬프트 지시대로 "빈 채로 둠") decisions는 null', () => {
  const text = '[맥락]\n지금 비중이 적절합니다.\n\n[의사결정]';
  const { context, decisions } = parseDepartmentResponse(text);
  assert.equal(context, '지금 비중이 적절합니다.');
  assert.equal(decisions, null);
});

test('[막아야 함] parseDepartmentResponse: 긴 하이픈(em dash)이 마침표로 치환됨(2026-09-01 오너 지시 — "긴 하이픈 다 제외")', () => {
  const text = '[결론]\n정상입니다 — 특별한 이상 없음.\n\n[맥락]\n지표가 조용합니다 — 근거는 다음과 같습니다.';
  const { conclusion, context } = parseDepartmentResponse(text);
  assert.doesNotMatch(conclusion, /—/);
  assert.doesNotMatch(context, /—/);
  assert.equal(conclusion, '정상입니다. 특별한 이상 없음.');
});

test('parseDepartmentResponse: 마커 순서가 뒤바뀌어도(의사결정이 맥락보다 먼저) 위치 기준으로 정확히 분리', () => {
  const text = '[의사결정]\n- 항목1\n\n[맥락]\n근거 문단';
  const { context, decisions } = parseDepartmentResponse(text);
  assert.equal(context, '근거 문단');
  assert.deepEqual(decisions, ['항목1']);
});

test('[막아야 함] parseDepartmentResponse: 모델이 프리앰블에 마커 세 개를 나열해도(문장 중간) 실제 마커 위치를 정확히 찾음(2026-09-01 코드리뷰 지적 — 프리앰블이 [결론]/[맥락]/[의사결정]을 언급하면 예전엔 진짜 답변 전체가 decisions로 밀려 들어갔음)', () => {
  const text = '요청하신 [결론]/[맥락]/[의사결정] 형식으로 답변드립니다.\n\n[결론]\n진짜 결론.\n\n[맥락]\n진짜 근거.\n\n[의사결정]\n- 진짜 항목';
  const { conclusion, context, decisions } = parseDepartmentResponse(text);
  assert.equal(conclusion, '진짜 결론.');
  assert.equal(context, '진짜 근거.');
  assert.deepEqual(decisions, ['진짜 항목']);
});

// stripEmDash — 2026-09-01 코드리뷰 HIGH 지적: 첫 버전은 \s{2,} 압축이 줄바꿈까지
// 삼켜서 여러 줄로 나뉜 문장·불릿을 한 줄로 뭉갰다. 줄바꿈은 보존해야 한다.

test('[막아야 함] stripEmDash: 줄바꿈은 보존(빈 줄로 구분된 여러 문장을 한 문단으로 뭉개지 않음)', () => {
  const text = '첫째.\n\n둘째.\n\n셋째.';
  assert.equal(stripEmDash(text), '첫째.\n\n둘째.\n\n셋째.');
});

test('[막아야 함] stripEmDash: 빈 줄로 구분된 여러 [의사결정] 불릿이 하나로 뭉개지지 않음(formatFactsMessage 경유 확인)', () => {
  const { decisions } = parseDepartmentResponse('[의사결정]\n- 항목1\n\n- 항목2\n\n- 항목3');
  assert.deepEqual(decisions, ['항목1', '항목2', '항목3']);
});

test('stripEmDash: 한글 조사 바로 뒤(공백 없음)에 붙은 긴 하이픈도 치환', () => {
  assert.equal(stripEmDash('부족합니다—근거는 다음과 같습니다.'), '부족합니다. 근거는 다음과 같습니다.');
});

test('stripEmDash: 문장 맨 앞의 긴 하이픈은 선행 마침표 없이 깔끔하게 제거', () => {
  assert.equal(stripEmDash('— 지켜볼 단계입니다.'), '지켜볼 단계입니다.');
});

test('stripEmDash: en dash(–)·하이픈(-)·날짜범위·음수 부호는 손대지 않음(진짜 em dash만 대상)', () => {
  assert.equal(stripEmDash('2026-08-01–2026-08-31 기간, 갭 -1.98%p'), '2026-08-01–2026-08-31 기간, 갭 -1.98%p');
});

test('stripEmDash: 빈 값이면 빈 문자열(안 터짐)', () => {
  assert.equal(stripEmDash(null), '');
  assert.equal(stripEmDash(undefined), '');
});

// formatFactsMessage 레벨에서도 긴 하이픈이 걸러짐(2026-09-01 코드리뷰 HIGH 지적 —
// parseDepartmentResponse를 안 거치는 소비자(예: proposal-flow.mjs가 LLM reason을
// 직접 context에 꽂는 경로)엔 예전엔 이 규칙이 전혀 안 걸렸다. 렌더링 시점에 일괄
// 적용해 모든 소비자를 커버한다).
test('[막아야 함] formatFactsMessage: parseDepartmentResponse를 안 거치고 직접 넘긴 context·conclusion·decisions에도 긴 하이픈이 제거됨', () => {
  const msg = formatFactsMessage({
    departmentLabel: '투자전략실 Athena',
    facts: ['사실1'],
    conclusion: '승인됨 — 검토 완료.',
    context: '리츠 비중이 부족합니다 — 배분을 제안합니다.',
    decisions: ['배분할지 — 기다릴지'],
  });
  assert.doesNotMatch(msg, /—/);
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
