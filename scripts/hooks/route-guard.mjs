#!/usr/bin/env node
// UserPromptSubmit 훅 — 투자 업무 요청을 감지해 "부서 위임" 리마인드를 메인 세션(Zeus) 컨텍스트에
// 결정론으로 주입한다. 헌장 §3 라우팅 신뢰성의 1차 강제 레버(지침 자가체크는 2차 안전망).
//
// I/O 계약(Claude Code UserPromptSubmit):
// - stdin: JSON { prompt, session_id, cwd, ... }
// - stdout: 출력 텍스트는 프롬프트 처리 전 컨텍스트로 주입된다. 매칭 시에만 1블록 방출.
// - exit: 항상 0. 차단이 아니라 리마인드다(오발은 무해). 파싱/기타 실패도 조용히 통과.
//
// 판정 로직은 순수함수 classifyRequest(route-keywords.mjs, 테스트됨)에 위임 — 이 파일은 I/O만.

import { classifyRequest } from '../lib/route-keywords.mjs';

const DEPT_LABEL = {
  athena: '투자전략실 Athena',
  themis: '리스크관리실 Themis',
  hermes: '운영실 Hermes',
  apollo: '비서실 Apollo',
};

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    // stdin이 없거나(TTY) 지연되면 매달리지 않게 즉시 방어.
    if (process.stdin.isTTY) return resolve('');
    // 방어: non-TTY 파이프가 'end'를 안 보내고 매달리는 경우 하네스 timeout(10s)에만 의존하지
    // 않고 내부에서 조기 해제(매 프롬프트마다 도는 훅이라 지연은 곧 입력 지연으로 체감된다).
    const t = setTimeout(() => resolve(buf), 2000);
    if (typeof t.unref === 'function') t.unref();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (buf += c));
    process.stdin.on('end', () => { clearTimeout(t); resolve(buf); });
    process.stdin.on('error', () => { clearTimeout(t); resolve(''); });
  });
}

async function main() {
  let prompt = '';
  try {
    const raw = await readStdin();
    if (raw) prompt = String(JSON.parse(raw)?.prompt ?? '');
  } catch {
    // 파싱 실패 → 조용히 통과(무해).
    process.exit(0);
  }

  const { delegate, dept } = classifyRequest(prompt);
  if (!delegate) process.exit(0);

  const label = DEPT_LABEL[dept] ?? '해당 부서';
  // system-reminder 톤(하네스가 컨텍스트로 주입). 차단 아님 — 투자 업무일 때만 위임하도록 유도.
  process.stdout.write(
    `<system-reminder>` +
      `[판테온 라우팅] 이 요청이 투자 업무라면 직접 처리하지 말고 부서에 위임하라(헌장 §1·§3). ` +
      `1차 추정 부서: ${label}. Agent tool로 이름 없이 동기 스폰(run_in_background:false)하고, ` +
      `무거운 조회·평가는 부서 컨텍스트에 격리한 채 필수입력 블록만 회수해 종합하라. ` +
      `게이트 결정(성향 갱신·확정/기각·차단해제·주문/리밸런싱 제안)이면 부서 필수입력을 모아 복합 종합(§2). ` +
      `요청이 투자 업무가 아니거나(코드 수정 등) 이미 위임 경로면 이 리마인드는 무시하라.` +
      `</system-reminder>\n`,
  );
  process.exit(0);
}

main();
