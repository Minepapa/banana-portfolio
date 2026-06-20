/**
 * 포지션저널 시트 셋업 + 기존 보유종목 전제(thesis) 백필 — 1회 실행(멱등)
 *
 * 거래 생애주기 루프의 토대:
 *   ① 거래직전 의사결정 → 전제 기록 → ② 전제 훼손 감시 → ③ 청산 결과 채점·교훈
 * 세 단계가 이 한 시트를 공유한다.
 *
 * 컬럼(A~P):
 *   A 종목명 · B 티커 · C 시장 · D 계좌 · E 유형(배분/확신)
 *   F 전제 · G 목표 · H 이탈조건 · I 예상보유 · J 진입일
 *   K 상태(보유/청산) · L 청산일 · M 청산결과 · N 교훈
 *   O 확인여부(대기/확인) · P 갱신시각
 *
 * 사용법:
 *   node scripts/setup/setup-position-journal.mjs --dump     # 보유종목+종목노트 덤프(초안 작성용)
 *   node scripts/setup/setup-position-journal.mjs --dry-run  # 적재 대상만 출력
 *   node scripts/setup/setup-position-journal.mjs            # 시트 생성 + 누락분 백필
 */

import { getToken, getRange, appendValues, setValues, ensureSheet, readHoldings, nowKST, todayKST } from '../lib/sheets-common.mjs';

const args = process.argv.slice(2);
const DUMP = args.includes('--dump');
const DRY_RUN = args.includes('--dry-run');
const explicitToken = args.find(a => !a.startsWith('--')); // launchd run.sh 가 SA 토큰을 positional 로 전달

const SHEET = '포지션저널';
const HEADER = ['종목명', '티커', '시장', '계좌', '유형', '전제', '목표', '이탈조건', '예상보유', '진입일', '상태', '청산일', '청산결과', '교훈', '확인여부', '갱신시각'];

// 배분형(자산군 대표 ETF/펀드) 분류용 키워드
const ALLOC_KW = /ETF|펀드|액티브|플러스|TIGER|KODEX|ACE|RISE|SOL|KBSTAR|ARIRANG|HANARO|TDF|채권|국고|리츠|REIT|배당|커버드콜|단기|MMF|머니마켓|금현물|S&P|나스닥|지수/i;
const classify = (name) => ALLOC_KW.test(name) ? '배분' : '확신';

// 순수 현금행은 전제 없음 → 저널 제외(자산분배에서도 제외되는 행)
const SKIP = new Set(['예수금']);

// ── 전제 초안(THESES): 종목명 → { type?, thesis, target, exit, hold, entry? } ──
// 에이전트(나)가 보유종목·종목노트(2026-06)·배분맥락을 보고 작성. 사용자 확인 대기 상태로 적재.
const THESES = {
  // ── 확신형(개별주) ──
  '삼성전자': { type:'확신', thesis:'HBM4 공급 정상화로 DS 마진 회복(Q1 영익률 42.7%), 순현금 119조·Fwd PER 6.8x로 하방 제한된 반도체 코어', target:'30% (장기)', exit:'HBM4 경쟁 열위 고착 / DS 마진 재악화 / 파운드리 구조조정 장기화', hold:'장기(2년+)' },
  '삼성바이오로직스': { type:'확신', thesis:'글로벌 1위 CDMO, 5공장 풀가동+미국공장으로 이익 레버리지. 영익률 46%, 매출 +26% YoY 고성장·고마진 동시', target:'25% (장기)', exit:'노사갈등 장기화로 가동 차질 / 성장 둔화에 PER 53x 멀티플 축소', hold:'장기', entry:'2026-05-12' },
  'SK하이닉스': { type:'확신', thesis:'HBM 시장 리더, AI 메모리 수요 최대 수혜. 메모리 업사이클 핵심 보유', target:'30% (장기)', exit:'HBM 공급과잉 전환 / 메모리 다운사이클 진입 / 후발 추격 점유율 잠식', hold:'장기' },
  '메리츠금융지주': { type:'확신', thesis:'ROE 21%(동종 1.76배), PER 5.6x·PBR 1.17x 역사적 하단. 자사주 소각 중심 주주환원', target:'30% (장기)', exit:'배당·소각 정책 후퇴 / 영업이익 추가 하락 추세 / IFRS17·금리 운용수익 압박', hold:'장기' },
  '애플': { type:'확신', thesis:'서비스 고마진 믹스 확대+생태계 락인. 안정적 현금창출·자사주 매입 지속', target:'25% (장기)', exit:'아이폰 수요 구조적 둔화 / AI 전략 지연으로 교체수요 약화', hold:'장기' },
  '테슬라': { type:'확신', thesis:'순현금 $28.9B·유동비율 2.04 견고. Fwd PER 168x는 로보택시/AI 기대 선반영 — 실현 시 재평가', target:'30% (장기)', exit:'FSD·로보택시 상용화 지연으로 기대 미실현 → 밸류 하방 / 해외주식 33% 비중 추가 확대', hold:'장기' },
  '엔비디아': { type:'확신', thesis:'AI 인프라 폭발 성장(매출 +85% YoY, 영익률 65.6%). Fwd PER 17x·PEG 0.66 성장 대비 합리적, 순현금 $40B', target:'40% (장기)', exit:'미중 AI칩 수출규제로 중국향(~20%) 직격 / AI capex 사이클 둔화', hold:'장기' },
  '알파벳 Class A': { type:'확신', thesis:'검색 현금창출+클라우드 성장+Gemini로 AI 경쟁 복귀. 빅테크 중 상대적 밸류 매력', target:'25% (장기)', exit:'검색 점유율 AI 챗봇에 구조적 잠식 / 반독점 분할 리스크 현실화', hold:'장기' },
  '마이크로소프트': { type:'확신', thesis:'Azure+Copilot AI 수익화 선두, 구독 기반 현금흐름. 엔터프라이즈 AI 1순위 수혜', target:'25% (장기)', exit:'Azure 성장 둔화 / AI capex 회수 지연으로 마진 압박', hold:'장기' },
  'VIP한국형가치투자증권자투자신탁(주식)-C-Pe': { type:'확신', thesis:'국내 가치투자 위탁운용(액티브 펀드) — 저평가 장기 복리. 직접 종목선정 대체', target:'시장 초과수익(장기)', exit:'운용성과 시장 대비 부진 누적(2년+) / 가치투자 철학 이탈', hold:'장기' },
  '삼척블루파워12': { type:'확신', thesis:'개별 회사채 — 만기보유로 표면이자 수취(인컴). 5.32% 쿠폰', target:'만기까지 이자 수취', exit:'발행사 신용등급 강등 / 디폴트·차환 위험 징후', hold:'만기보유' },

  // ── 배분형(자산군 대표 ETF/펀드) ──
  'TIGER 미국배당다우존스': { type:'배분', thesis:'미국 배당성장(SCHD형) 대표 — 배당주 자산군 코어', target:'배당주 목표비중 유지', exit:'배당성장 둔화 / 더 저비용 대표 등장 / 배당주 비중 초과', hold:'장기 코어' },
  'PLUS 고배당주': { type:'배분', thesis:'국내 고배당 대표 — 원화 인컴 공급', target:'국내 배당 인컴 유지', exit:'편입종목 배당컷 확산 / 배당주 비중 초과', hold:'장기' },
  'TIGER 리츠부동산인프라TOP10액티브': { type:'배분', thesis:'국내 리츠 인컴 대표(액티브) — 리츠 자산군', target:'리츠 목표비중 유지', exit:'금리 급등 지속으로 리츠 구조 훼손 / 분배컷 / 액티브 underperform', hold:'장기' },
  'TIGER 리츠부동산인프라': { type:'배분', thesis:'국내 리츠 패시브 대표(연금·ISA) — 리츠 인컴', target:'리츠 목표비중 유지', exit:'금리 장기 급등 / 분배컷 / 편입 REIT 공실 악화', hold:'장기' },
  'TIGER KRX금현물': { type:'배분', thesis:'금 자산군 대표(원화, 연금) — 인플레·위기 헤지', target:'금 목표비중(~5%) 유지', exit:'실질금리 급등 지속 / 금 비중 초과', hold:'장기' },
  '금 99.99K': { type:'배분', thesis:'실물 금괴(위탁) — 금 자산군 분산', target:'금 목표비중 유지', exit:'실질금리 급등 / 금 비중 초과', hold:'장기' },
  '외화 RP': { type:'배분', thesis:'달러 자산군 파킹(RP) — 환분산·대기자금', target:'달러 목표비중 유지', exit:'원화 강세 전환 확신 / 달러 매수기회로 소진', hold:'중기' },
  '삼성신종종류형 MMF 제4호': { type:'배분', thesis:'연금 단기 현금 파킹(MMF) — 매수 대기자금', target:'기회 발생 시 소진', exit:'매수 기회 포착 시 즉시 전환', hold:'단기' },
  'KODEX CD금리액티브(합성)': { type:'배분', thesis:'CD금리 파킹(연금) — 무위험 단기 수익+대기자금', target:'단기 금리 수취', exit:'현금 필요 / 더 나은 자산 배분 기회', hold:'단기~중기' },
  'KoAct K수출핵심기업 TOP30액티브': { type:'배분', thesis:'국내 수출 핵심주 테마 액티브 — 국내주식 위성', target:'국내주식 비중 내 위성', exit:'수출 사이클 둔화 / 액티브 벤치마크 하회 누적', hold:'중기' },
  'TIGER 미국S&P500': { type:'배분', thesis:'미국 대형주 코어(연금) — 해외주식 핵심', target:'해외주식 목표비중 유지', exit:'해외주식 비중 초과 / 환율 급변', hold:'장기 코어' },
  'KODEX 미국나스닥100': { type:'배분', thesis:'미국 성장주 코어(연금) — 해외주식 핵심', target:'해외주식 목표비중 유지', exit:'해외주식 비중 초과', hold:'장기 코어' },
  'KoAct 미국나스닥성장기업액티브': { type:'배분', thesis:'나스닥 성장 액티브 위성 — 초과수익 추구', target:'해외주식 내 위성', exit:'액티브 벤치마크(나스닥100) 하회 누적', hold:'중기' },
  'TIME Korea플러스배당액티브': { type:'배분', thesis:'국내 배당 액티브(ISA) — 배당주 인컴', target:'배당주 목표비중 유지', exit:'배당컷 / 액티브 부진 / 배당주 비중 초과', hold:'장기' },
  'TIGER 미국배당다우존스타겟데일리커버드콜': { type:'배분', thesis:'미배당+데일리 커버드콜(ISA) — 고분배 인컴', target:'월 분배 인컴', exit:'강상승장 기회비용 과다 / 분배율 급락', hold:'중기 인컴' },
  'ACE 미국하이일드액티브(H)': { type:'배분', thesis:'미국 하이일드 채권 인컴(ISA, 환헤지) — 채권 인컴', target:'고금리 인컴 수취', exit:'신용스프레드 급등(경기침체 신호) / 디폴트율 상승', hold:'중기' },
  'TIGER TDF2045 적격': { type:'배분', thesis:'IRP 글라이드패스 코어 — 자동 자산배분 적립', target:'2045 은퇴시점 자동 조정', exit:'(장기 적립 — 원칙적 이탈 없음)', hold:'초장기' },
};

async function main() {
  const token = await getToken(explicitToken || null, { allowBrowser: false });
  const holdings = await readHoldings(token);

  if (DUMP) {
    console.log('\n=== 보유종목 (4계좌 dedupe) ===');
    for (const h of holdings) {
      const accts = h.accounts.map(a => `${a.acct}:${a.type}(${a.qty}주/${a.invest.toLocaleString()}원)`).join(' · ');
      console.log(`• ${h.name} [${h.market}] 자동유형=${classify(h.name)}\n    ${accts}`);
    }
    console.log('\n=== 종목투자노트 (A2:U) ===');
    const notes = await getRange(token, '종목투자노트!A2:U');
    for (const r of notes) {
      const name = String(r[1] ?? '').trim();
      if (!name) continue;
      console.log(`• ${name} | 결론=${String(r[4] ?? '').trim()} | 상태=${String(r[14] ?? '').trim()} | 진입일=${String(r[15] ?? '').trim()} | 목표기간=${String(r[17] ?? '').trim()} | 목표수익=${String(r[18] ?? '').trim()}`);
      const reasons = String(r[10] ?? '').trim();
      if (reasons) console.log(`    근거: ${reasons.slice(0, 200)}`);
      const risks = String(r[11] ?? '').trim();
      if (risks) console.log(`    리스크: ${risks.slice(0, 200)}`);
    }
    return;
  }

  const created = await ensureSheet(token, SHEET, HEADER);
  if (created) console.log(`🆕 ${SHEET} 생성`);

  // 기존 저널 전체 행(멱등 + 청산 감지)
  const existingRows = await getRange(token, `${SHEET}!A2:P`).catch(() => []);
  const existing = new Set(existingRows.map(r => String(r[0] ?? '').trim()).filter(Boolean));

  // 종목명 끝의 "(5.32%)" 같은 가변 접미사를 떼고도 전제를 찾도록
  const lookupThesis = (name) => THESES[name] || THESES[name.replace(/\s*\([^)]*\)\s*$/, '').trim()] || {};

  const rows = [];
  for (const h of holdings) {
    if (existing.has(h.name) || SKIP.has(h.name)) continue;
    const t = lookupThesis(h.name);
    const acctList = [...new Set(h.accounts.map(a => a.acct))].join('/');
    rows.push([
      h.name,                       // A 종목명
      h.ticker || '',               // B 티커
      h.market,                     // C 시장
      acctList,                     // D 계좌
      t.type || classify(h.name),   // E 유형
      t.thesis || '',               // F 전제
      t.target || '',               // G 목표
      t.exit || '',                 // H 이탈조건
      t.hold || '',                 // I 예상보유
      t.entry || '',                // J 진입일
      '보유',                       // K 상태
      '',                           // L 청산일
      '',                           // M 청산결과
      '',                           // N 교훈
      (t.thesis ? '대기' : '미작성'), // O 확인여부
      nowKST(),                     // P 갱신시각
    ]);
  }

  console.log(`📋 보유 ${holdings.length}개 · 기적재 ${existing.size}개 · 신규 ${rows.length}개`);
  for (const r of rows) console.log(`  + ${r[0]} [${r[4]}] ${r[5] ? '전제O' : '전제미작성'}`);
  if (rows.length && !DRY_RUN) await appendValues(token, `${SHEET}!A2`, rows);

  // ── 기존 행 빈 목표(G)·이탈조건(H) 보충: THESES에 정의됐으나 시트가 비어있는 셀 채움 ──
  const fills = [];
  for (let idx = 0; idx < existingRows.length; idx++) {
    const name = String(existingRows[idx][0] ?? '').trim();
    if (!name) continue;
    const t = lookupThesis(name);
    if (!t.target && !t.exit) continue;
    const isEmpty = (v) => { const s = String(v ?? '').trim(); return !s || s.startsWith('#'); };
    const curTarget = String(existingRows[idx][6] ?? '').trim();
    const curExit   = String(existingRows[idx][7] ?? '').trim();
    if (!isEmpty(curTarget) && !isEmpty(curExit)) continue;
    const row = idx + 2;
    if (isEmpty(curTarget) && t.target) { fills.push({ row, col: 'G', name, field: '목표', val: t.target }); }
    if (isEmpty(curExit)   && t.exit)   { fills.push({ row, col: 'H', name, field: '이탈조건', val: t.exit }); }
  }
  for (const f of fills) {
    console.log(`  ✏ ${f.name} ${f.field} 보충: ${f.val.slice(0, 60)}`);
    if (!DRY_RUN) await setValues(token, `${SHEET}!${f.col}${f.row}`, [[f.val]]);
  }

  // ── 청산 감지: 저널엔 '보유'인데 현재 보유종목에 없는 종목 → 매도된 것 → 상태=청산, 청산일 기록 ──
  // (③ 반성 단계의 트리거. 청산결과·교훈은 빈칸 → 앱 반성 카드에서 채움)
  const norm = (s) => String(s ?? '').normalize('NFC').replace(/\s*\([^)]*\)\s*$/, '').replace(/\s+/g, '').toLowerCase();
  const heldKeys = new Set();
  for (const h of holdings) { heldKeys.add(norm(h.name)); if (h.ticker) heldKeys.add(String(h.ticker).toUpperCase()); }
  const closures = [];
  existingRows.forEach((r, idx) => {
    const name = String(r[0] ?? '').trim();
    if (!name || SKIP.has(name)) return;
    const status = String(r[10] ?? '').trim() || '보유';
    if (status === '청산') return;
    const ticker = String(r[1] ?? '').trim().toUpperCase();
    const stillHeld = heldKeys.has(norm(name)) || (ticker && heldKeys.has(ticker));
    if (!stillHeld) closures.push({ row: idx + 2, name });
  });
  for (const c of closures) {
    console.log(`  ⚑ 청산 감지: ${c.name} (행 ${c.row}) → 상태=청산 · 청산일=${todayKST()}`);
    if (!DRY_RUN) await setValues(token, `${SHEET}!K${c.row}:L${c.row}`, [['청산', todayKST()]]);
  }

  const summary = [];
  if (rows.length) summary.push(`${rows.length}건 백필`);
  if (closures.length) summary.push(`${closures.length}건 청산`);
  console.log(DRY_RUN ? '\n(드라이런 — 쓰기 없음)' : (summary.length ? `\n✅ ${summary.join(' · ')} 완료` : '변경 없음'));
}

main().catch(e => { console.error('\n❌ 오류:', e.message); process.exit(1); });
