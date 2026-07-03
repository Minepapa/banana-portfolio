import { useState, useEffect } from 'react';
import { parseJobStatus } from '../lib/jobHealth.js';

// 탭 진입·전역 갱신 시 발화하는 데이터 페치 effect 모음.
// App.jsx에서 추출 — kpiTrades·jobStatus·execPending 상태를 관리하고 반환.
export function useTabData({ sheets, tab, syncTradeExecutions }) {
  const [kpiTrades, setKpiTrades] = useState(null);   // null=미로딩
  const [jobStatus, setJobStatus] = useState(null);   // null=미로딩
  const [execPending, setExecPending] = useState(null); // null=미로딩

  // 체결내역 탭 진입 시 동기화
  useEffect(() => {
    if (tab === '체결내역' && sheets.auth === 'signed-in') {
      syncTradeExecutions();
    }
  }, [tab, sheets.auth]); // eslint-disable-line

  // KPI 탭: 체결내역 최초 1회 로드
  useEffect(() => {
    if (tab === 'kpi' && sheets.auth === 'signed-in' && kpiTrades === null) {
      sheets.readRange('체결내역!A2:M')
        .then(vals => setKpiTrades((vals || []).map(row => ({ row }))))
        .catch(() => setKpiTrades([]));
    }
  }, [tab, sheets.auth]); // eslint-disable-line

  // 잡 상태: signed-in 후 1회 로드. 토큰 갱신(lastSync 변경) 시 재시도.
  useEffect(() => {
    if (sheets.auth === 'signed-in' && jobStatus === null) {
      sheets.readRange('잡상태!A2:F')
        .then(rows => setJobStatus(parseJobStatus(rows)))
        .catch(e => { if (e?.status !== 401) console.error('잡상태 read failed:', e); });
    }
  }, [sheets.auth, jobStatus, sheets.lastSync]); // eslint-disable-line

  // 오늘 탭: 미처리 체결 수 집계 (종목명 있고 처리 플래그 없는 행)
  useEffect(() => {
    if (tab !== '오늘' || sheets.auth !== 'signed-in') return;
    let cancelled = false;
    Promise.all([sheets.readRange('체결내역!A2:M'), sheets.readTradeProcessedFlags()])
      .then(([vals, flags]) => {
        if (cancelled) return;
        const n = (vals || []).filter((row, i) => String(row[5] ?? '').trim() !== '' && !(flags[i] ?? false)).length;
        setExecPending(n);
      })
      .catch(() => { if (!cancelled) setExecPending(0); });
    return () => { cancelled = true; };
  }, [tab, sheets.auth, sheets.lastSync]); // eslint-disable-line

  return { kpiTrades, jobStatus, execPending };
}
