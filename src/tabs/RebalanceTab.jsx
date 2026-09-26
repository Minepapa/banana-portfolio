// 자산분배 탭 — 자산군 파이 + 목표 vs 현재 비중 + 리밸런싱 필요액. v2 재배선
// (2026-08-13): 읽기 전용. 목표비중은 Athena 5/25 룰의 확정값이라(2026-08-23 재조정
// 이후 5자산군 — 정확한 값은 docs/ARCHITECTURE-V2.md 확인, 여기 숫자를 복사해 캐싱
// 하지 않는다 — 이 탭 자체는 mirror의 a.target을 그대로 표시할 뿐 하드코딩 없음)
// 애초에 앱에서 수동 조정하는 대상이 아니다(문서: "목표비중(확정 정본)") — 편집 UI
// 제거.
//
// ⚠️ 2026-08-22 오너 확정 — 위탁·연금저축·금(금현물)은 "전체를 100으로 두고 나눈"
// 하나의 합산 풀이지 서로 다른 3개 관점이 아니다. 예전엔(2026-08-21 pooled 계산
// 도입 직후) 계산값은 이미 합산 풀 기준이면서도 화면엔 여전히 계좌별 탭 3개로
// 쪼개져 같은 숫자가 3번 보이는 것처럼 보였다 — 이제 그 셋을 "통합" 탭 하나로
// 합치고, ISA·IRP·CMA(각자 다른 목적의 단일자산 계좌)만 별도 탭으로 남긴다.
// 이 선택 상태는 대시보드·보유종목 탭이 공유하는 acctKey(실계좌 6개 전용)와
// 의도적으로 분리한다 — 여긴 "통합" 같은 가상 항목이 섞여 의미가 다르다.
import { useState } from 'react';
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
} from "recharts";
import { COLORS, PROFIT_POS, PROFIT_NEG } from '../lib/colors.js';
import { PAPER, PAPER_2, CARD_BG, RADIUS, INK, INK_2, BORDER, BORDER_COLOR, RADIUS_SM, MONO } from '../lib/theme.js';
import { DeptBadge } from '../lib/primitives.jsx';

const POOLED_KEY = 'POOLED';

// 5/25 밴드 이탈 판정(2026-09-12 수정, 오너 지적 — "음영표시가 사라졌어") — 원래
// 여기 두 곳(비중 테이블·리밸런싱 필요 목록) 모두 절대 5%p 고정 임계값만 썼는데,
// 이 프로젝트의 실제 5/25 룰(scripts/lib/rebalance-gap.mjs computeBandEdgeDistance)
// 은 "절대 5%p·상대 25% 중 더 좁은 쪽"이다 — 목표비중이 작은 자산군(금·달러 10%)은
// 상대 25%=2.5%p가 더 좁아 실제로는 진작 이탈인데도 5%p 기준으로는 하이라이트가
// 안 뜨고 있었다("사라진 것처럼" 보인 원인). 백엔드가 이 판정 자체를 화면용 데이터에
// 안 실어줘(allocation-snapshot.mjs가 breached를 계산 안 함) target 값만으로 프론트가
// 동일 공식을 그대로 재현한다.
function isBandBreached(target, diff) {
  const bandEdge = Math.min(5, target * 0.25);
  return Math.abs(diff) >= bandEdge;
}

// 밴드 이탈 강조 배경(2026-09-12, 오너 지시 — "퍼센트와 금액에 동일한 투명도로,
// 금에 적용된 색으로 통일") — 비중 테이블은 불투명 베이지(#EAE6DA), 리밸런싱
// 필요 목록은 같은 색의 40% 투명도(#EAE6DA66)로 서로 달랐다. 이제 두 곳 다 이
// 상수 하나(금 자산군 색 COLORS.금=#F5C842에 40% 알파)로 통일한다.
const BAND_BREACH_BG = `${COLORS.금}66`;

// views: { POOLED, ISA, IRP, CMA } — 전부 rebalanceAccountFromMirror(또는
// pooledAccountFromMirror)와 같은 모양({label, color, assets: [{name,target,ratio,
// rebalAmt,eval}], ...}). App.jsx가 미리 조립해 넘긴다(HoldingsTab이 쓰는
// accountsFromMirror의 `accounts`는 assets가 없는 다른 모양이라 여기 재사용 불가).
export default function RebalanceTab({ views, isMobile, baseFont, fmt }) {
  const [rebalKey, setRebalKey] = useState(POOLED_KEY);
  const acct = views[rebalKey];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <DeptBadge dept="athena" />
      </div>
      {/* 선택 — 통합(위탁+연금저축+금) + ISA·IRP·CMA(각자 단일목적 계좌) 4개. */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 16 }}>
        {Object.entries(views).map(([k, v]) => (
          <button key={k} onClick={() => setRebalKey(k)} style={{
            flex: "1 1 auto", minWidth: 72, padding: isMobile ? "8px 4px" : "6px 4px",
            textAlign: 'center',
            borderRadius: RADIUS_SM,
            border: `1px solid ${rebalKey === k ? v.color : BORDER_COLOR}`,
            background: rebalKey === k ? `${v.color}22` : "transparent",
            color: rebalKey === k ? v.color : INK_2,
            cursor: "pointer", fontSize: 11, fontFamily: baseFont,
          }}>
            {v.label}
          </button>
        ))}
      </div>

      {/* 자산군 구성 파이 (최상단) — 이 계좌 "자신의" 보유 비중(파이 조각·범례 %가 같은
          분모를 쓴다). 2026-08-21부터 목표/현재비중 테이블의 %는 위탁+연금저축+금현물
          합산 풀 기준으로 바뀌었지만, 이 파이는 계속 "이 계좌 안에 실제로 뭐가 얼마나
          있는지"를 보여주는 용도라 a.eval(계좌 자신의 보유액)을 그대로 분모로 쓴다 —
          합산 풀 비중(a.ratio)을 범례에 쓰면 조각 크기와 라벨 %가 어긋난다(코드리뷰
          지적: 금현물처럼 단일 자산군만 있는 계좌는 조각이 100%인데 라벨이 예: "6.2%"로
          찍히는 모순이 생겼었음). */}
      {acct.assets.some(a => a.eval > 0) && (() => {
        const pieAssets = acct.assets.filter(a => a.eval > 0);
        const pieTotal = pieAssets.reduce((s, a) => s + a.eval, 0);
        return (
          <div style={{ background: CARD_BG, borderRadius: RADIUS, padding: "16px", marginBottom: 16 }}>
            <div style={{ fontSize: 10, letterSpacing: 2, color: INK_2, marginBottom: 12 }}>
              자산군 구성 ({rebalKey === POOLED_KEY ? '위탁+연금저축+금 합산 기준' : '이 계좌 보유 기준'})
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <ResponsiveContainer width="100%" height={160}>
                  <PieChart accessibilityLayer={false}>
                    <Pie
                      data={pieAssets.map(a => ({ name: a.name, value: a.eval }))}
                      cx="50%" cy="50%" innerRadius={40} outerRadius={65} dataKey="value" paddingAngle={3}>
                      {pieAssets.map((a, i) => (
                        <Cell key={i} fill={COLORS[a.name] || "#aaa"} stroke={PAPER} strokeWidth={2} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(v) => `₩${v.toLocaleString()}`}
                      contentStyle={{ background: PAPER_2, border: BORDER, borderRadius: RADIUS_SM, fontSize: 11 }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div style={{ width: 120, flexShrink: 0 }}>
                {pieAssets.map(a => (
                  <div key={a.name} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                    <div style={{ width: 8, height: 8, borderRadius: 0, background: COLORS[a.name] || '#aaa', flexShrink: 0 }} />
                    <span style={{ fontSize: 11, color: INK_2, flex: 1 }}>{a.name}</span>
                    <span style={{ fontSize: 11, color: INK , fontFamily: MONO}}>
                      {(pieTotal > 0 ? (a.eval / pieTotal) * 100 : 0).toFixed(1)}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })()}

      {/* 현재 vs 목표 비중 테이블 */}
      <div style={{ background: CARD_BG, borderRadius: RADIUS, padding: "16px", marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ fontSize: 10, letterSpacing: 2, color: INK_2 }}>목표 vs 현재 비중</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', padding: '4px 8px', marginBottom: 4 }}>
          <div style={{ flex: 1, fontSize: 10, color: INK_2, textAlign: 'center' }}>자산군</div>
          <div style={{ width: 60, textAlign: 'center', fontSize: 10, color: INK_2 }}>목표%</div>
          <div style={{ width: 50, textAlign: 'center', fontSize: 10, color: INK_2 }}>현재%</div>
          <div style={{ width: 60, textAlign: 'center', fontSize: 10, color: INK_2 }}>차이</div>
        </div>
        {acct.assets.map((a) => {
          const diff = parseFloat((a.ratio - a.target).toFixed(1));
          const highlight = isBandBreached(a.target, diff);
          return (
            <div key={a.name} style={{
              display: 'flex', alignItems: 'center', padding: '7px 8px',
              borderRadius: RADIUS_SM, marginBottom: 2,
              background: highlight ? BAND_BREACH_BG : 'transparent',
            }}>
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 8, height: 8, borderRadius: 0, background: COLORS[a.name] || '#aaa', flexShrink: 0 }} />
                <span style={{ fontSize: 12 }}>{a.name}</span>
              </div>
              <div style={{ width: 60, textAlign: 'center', fontSize: 12, color: INK_2 , fontFamily: MONO}}>
                {a.target}%
              </div>
              <div style={{ width: 50, textAlign: 'center', fontSize: 12, color: INK , fontFamily: MONO}}>{a.ratio}%</div>
              <div style={{ width: 60, textAlign: 'right', fontSize: 12, fontWeight: 700,
                color: diff > 0 ? PROFIT_POS : diff < 0 ? PROFIT_NEG : INK_2 }}>
                {diff > 0 ? '+' : ''}{diff}%p
              </div>
            </div>
          );
        })}
      </div>

      {/* 리밸런싱 필요 — 강조 배경은 진하지 않게(투명도 낮춤)+파랑/빨강 좌측강조선
          없앰(오너 지시, 2026-08-22, ExecutionsTab과 동일 원칙: 색은 최소한으로). */}
      <div style={{ background: CARD_BG, borderRadius: RADIUS, padding: "16px" }}>
        <div style={{ fontSize: 10, letterSpacing: 2, color: INK_2, marginBottom: 12 }}>리밸런싱 필요</div>
        {acct.assets.map((a) => {
          const amt = a.rebalAmt ?? 0;
          const diff = parseFloat((a.ratio - a.target).toFixed(1));
          const highlight = isBandBreached(a.target, diff);
          return (
            <div key={a.name} style={{
              display: 'flex', alignItems: 'center', padding: '10px 12px',
              borderRadius: RADIUS_SM, marginBottom: 4,
              background: highlight ? BAND_BREACH_BG : 'transparent',
            }}>
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 8, height: 8, borderRadius: 0, background: COLORS[a.name] || '#aaa', flexShrink: 0 }} />
                <span style={{ fontSize: 12 }}>{a.name}</span>
              </div>
              {/* ⚠️ amt(rebalAmt)는 "목표-현재"라 diff("현재-목표")와 부호가 반대다 —
                  그대로 amt>0?POS:NEG를 쓰면 위 "차이" 열과 색이 정반대로 나온다
                  (2026-08-25 오너 지적 — 같은 자산군인데 두 표가 반대색). 색은 항상
                  "초과(매도 필요)=빨강, 부족(매수 필요)=파랑" 기준으로 통일한다 —
                  amt<0(=목표보다 현재가 많음=초과=매도)일 때 PROFIT_POS(빨강),
                  amt>0(=부족=매수)일 때 PROFIT_NEG(파랑)로 diff 열과 부호를 맞춤. */}
              <div style={{ fontSize: 12, fontWeight: 700, color: amt < 0 ? PROFIT_POS : amt > 0 ? PROFIT_NEG : INK_2 , fontFamily: MONO}}>
                ₩{fmt(amt)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
