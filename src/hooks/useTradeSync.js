// 체결내역 동기화 훅: 체결 탭의 보유 반영·매도 수익금 기록·예수금 증감·셀 편집·저축금 반영을 묶음. App.jsx에서 추출 (동작 불변).
// 입력: { sheets, usdRate }. 반환: 트레이드 상태·setter·동기화 함수들.
import { useState, useCallback } from "react";
import { parseNum } from '../lib/textFormat.js';
import { KL_CFG, buildRowMap } from '../lib/sheetRows.js';

export function useTradeSync({ sheets, usdRate }) {
  const [tradeRows, setTradeRows] = useState([]);
  const [tradeSyncing, setTradeSyncing] = useState(false);
  const [tradeSyncMsg, setTradeSyncMsg] = useState('');
  // 저축금 반영 완료 거래 — 새로고침 후 이중 반영 방지 위해 거래 내용 키로 localStorage 영속화
  const [savingsAppliedRows, setSavingsAppliedRows] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem('banana_savings_applied') || '[]')); }
    catch { return new Set(); }
  });
  const [tradeEditOpen, setTradeEditOpen] = useState(false);
  const [tradeEditRowIdx, setTradeEditRowIdx] = useState(null);
  const [tradeEditValues, setTradeEditValues] = useState(Array(13).fill(''));
  const [tradeEditBusy, setTradeEditBusy] = useState(false);

  const addHoldingFromTrade = useCallback(async (acctKey, assetType, stockName, price, qty, currentPrice) => {
    const cfg = KL_CFG[acctKey];
    if (!cfg) throw new Error(`알 수 없는 계좌: ${acctKey}`);
    const rows = await sheets.readRange(cfg.range);
    const rowMap = buildRowMap(rows, cfg.start, cfg.end);
    let targetRow = null;
    for (const r of rowMap) {
      if (r.type === assetType && r.empty && r.hasA) { targetRow = r.row; break; }
    }
    if (targetRow === null) throw new Error(`${acctKey} > ${assetType}: 빈 행 없음`);
    const n = targetRow;
    await sheets.writeRange(`${acctKey}!B${n}:I${n}`, [
      stockName, price, qty,
      `=C${n}*D${n}`,
      currentPrice,
      `=H${n}-E${n}`,
      `=D${n}*F${n}`,
      `=H${n}/E${n}-1`,
    ]);
  }, [sheets]);

  const syncTradeExecutions = useCallback(async () => {
    if (tradeSyncing) return;
    setTradeSyncing(true);
    setTradeSyncMsg('동기화 중...');
    try {
      const tradeValues = await sheets.readRange('체결내역!A2:M');
      const tradeJFormulas = await sheets.readRange('체결내역!J2:J', 'FORMULA');
      const flags = await sheets.readTradeProcessedFlags();

      const rowsWithStatus = tradeValues.map((row, i) => ({ row, processed: flags[i] ?? false }));
      setTradeRows(rowsWithStatus);

      const toProcess = rowsWithStatus
        .map(({ row, processed }, i) => ({ row, i, processed }))
        .filter(({ row, processed }) => {
          if (processed) return false;
          if (row.length < 13) return false;
          return row.slice(0, 13).every(cell => String(cell ?? '').trim() !== '');
        });

      if (toProcess.length === 0) {
        setTradeSyncMsg(tradeValues.length > 0 ? '처리할 신규 내역 없음' : '체결내역 없음');
        setTimeout(() => setTradeSyncMsg(''), 3000);
        return;
      }

      const cheolSheetId = await sheets.getSheetId('체결내역');
      let processed = 0;
      const errors = [];

      for (const { row, i } of toProcess) {
        try {
          const buySell   = String(row[1] ?? '').trim(); // B
          const account   = String(row[2] ?? '').trim(); // C
          const assetType = String(row[4] ?? '').trim(); // E
          const stockName = String(row[5] ?? '').trim(); // F
          const price     = parseNum(row[6]);             // G
          const qty       = parseNum(row[7]);             // H
          const jFormula  = String(tradeJFormulas[i]?.[0] ?? '').trim();
          const currentPrice = jFormula.startsWith('=') ? jFormula : parseNum(row[9]); // J (formula or number)

          if (!account || !stockName) continue;

          const acctKey = ['ISA', '위탁', '연금저축', 'IRP'].find(k => account.includes(k));
          if (!acctKey) continue;

          const holdingRows = await sheets.readRange(`${acctKey}!A2:D60`);
          let matchRow = null;
          let lastType = '';
          for (let r = 0; r < holdingRows.length; r++) {
            const hr = holdingRows[r];
            const typeVal = String(hr[0] ?? '').trim();
            if (typeVal) lastType = typeVal;
            if (String(hr[1] ?? '').trim() === stockName) {
              matchRow = { row: 2 + r, type: lastType, price: parseNum(hr[2]), qty: parseNum(hr[3]) };
              break;
            }
          }

          const isBuy  = buySell.includes('매수');
          const isSell = buySell.includes('매도');

          const isOverseas = assetType.includes('해외');
          // 해외주식: G열 체결가는 parse-notifications이 ={usd}*설정!B2 수식으로 기록 → evaluated 값은 KRW
          // holdings C열은 USD 저장이므로 KRW→USD 변환 후 연산
          // 환율 미로드(usdRate=0) 시 변환 불가 → KRW를 USD로 잘못 저장하는 사고 방지 위해 스킵
          if (isOverseas && !(usdRate > 0)) {
            errors.push(`${stockName}: 환율 미로드 — 해외주식 처리 보류 (다음 동기화 재시도)`);
            continue;
          }
          const priceForCalc = isOverseas ? price / usdRate : price;

          // ── 1) 보유종목 반영 (유일한 재실행-위험 작업) ──────────────
          // 매도 전 평균매수단가 보존 (USD for 해외주식) — 행이 청산돼도 in-memory 값은 남음
          const avgBuyPrice = matchRow ? matchRow.price : 0;
          if (isBuy) {
            if (matchRow) {
              const newQty = matchRow.qty + qty;
              const rawAvg = newQty > 0
                ? (matchRow.price * matchRow.qty + priceForCalc * qty) / newQty
                : priceForCalc;
              const newAvgPrice = isOverseas
                ? Math.round(rawAvg * 100) / 100   // USD: 소수점 2자리
                : Math.round(rawAvg);               // KRW: 정수
              await sheets.writeRange(`${acctKey}!C${matchRow.row}:D${matchRow.row}`, [newAvgPrice, newQty]);
            } else {
              await addHoldingFromTrade(acctKey, assetType, stockName, priceForCalc, qty, currentPrice);
            }
          } else if (isSell && matchRow) {
            const newQty = matchRow.qty - qty;
            if (newQty <= 0) {
              await sheets.clearRowsRaw([`${acctKey}!B${matchRow.row}:I${matchRow.row}`]);
            } else {
              await sheets.writeRange(`${acctKey}!D${matchRow.row}`, [newQty]);
            }
          } else if (isSell && !matchRow) {
            errors.push(`${stockName}: 계좌(${acctKey})에서 종목을 찾을 수 없음 — 처리 건너뜀`);
            continue; // 완료 마킹 스킵
          }

          // ── 2) 보유 반영 직후 즉시 완료 마킹 ─────────────────────────
          // 보유종목 쓰기만이 재실행 시 위험(수량·평단 이중반영). 그 직후 마킹해 부분실패가
          // 같은 체결을 재처리하지 못하게 막는다. 이후 수익금·예수금은 best-effort —
          // 실패해도 이미 마킹돼 보유 이중반영은 없고, 오류만 표면화돼 수동 보정 가능.
          if (cheolSheetId !== null) {
            await sheets.markTradeProcessed(cheolSheetId, i + 1); // row2 → 0-based index 1
          }
          processed++;

          // ── 3) 수익금 기록 (매도) — best-effort ─────────────────────
          if (isSell && matchRow) {
            const profitRows = await sheets.readRange('수익금!A2:A');
            const nextRow = (profitRows?.length ?? 0) + 2;
            const dateStr = String(row[0] ?? '').trim();
            const sellPriceForProfit = isOverseas
              ? Math.round(priceForCalc * 100) / 100  // USD 소수점 2자리
              : price;
            // 해외주식: D·E는 USD, F는 KRW (×환율). 국내주식: D·E·F 모두 KRW
            const profitFormula = isOverseas
              ? `=(E${nextRow}-D${nextRow})*C${nextRow}*설정!$B$2`
              : `=(E${nextRow}-D${nextRow})*C${nextRow}`;
            await sheets.writeRange(`수익금!A${nextRow}:F${nextRow}`, [
              dateStr, stockName, qty, avgBuyPrice, sellPriceForProfit,
              profitFormula,
            ]);
          }

          // ── 4) 예수금 반영 — ISA·위탁 국내주식만 (해외주식은 외화RP 별도) · best-effort ──
          // 표시값은 E·H열(투자금=평가금). 즉시 피드백용이며 헤드리스 스크립트가 기준+델타로 최종 정합.
          if ((isBuy || isSell) && !assetType.includes('해외') && (acctKey === 'ISA' || acctKey === '위탁')) {
            const cashRowIdx = holdingRows.findIndex(hr => String(hr[1] ?? '').trim() === '예수금');
            if (cashRowIdx >= 0) {
              const cashRowNum = 2 + cashRowIdx;
              const cashCell = await sheets.readRange(`${acctKey}!H${cashRowNum}`);
              const currentCash = parseNum(cashCell?.[0]?.[0]);
              const tradeAmt = Math.round(price * qty);
              const newCash = isBuy ? Math.max(0, currentCash - tradeAmt) : currentCash + tradeAmt;
              await sheets.writeRange(`${acctKey}!E${cashRowNum}`, [newCash]);
              await sheets.writeRange(`${acctKey}!H${cashRowNum}`, [newCash]);
            }
          }
        } catch (e) {
          errors.push(String(e?.message ?? e));
        }
      }

      await sheets.fetch();

      const newValues = await sheets.readRange('체결내역!A2:M');
      const newFlags  = await sheets.readTradeProcessedFlags();
      setTradeRows(newValues.map((row, i) => ({ row, processed: newFlags[i] ?? false })));

      setTradeSyncMsg(errors.length > 0
        ? `${processed}건 완료 · ${errors.length}건 오류`
        : `${processed}건 동기화 완료`);
      setTimeout(() => setTradeSyncMsg(''), 5000);
    } catch (e) {
      console.error('체결내역 동기화 오류:', e);
      setTradeSyncMsg('동기화 오류');
      setTimeout(() => setTradeSyncMsg(''), 4000);
    } finally {
      setTradeSyncing(false);
    }
  }, [sheets, tradeSyncing, addHoldingFromTrade, usdRate]);

  const saveTradeEdit = useCallback(async () => {
    if (tradeEditRowIdx === null) return;
    setTradeEditBusy(true);
    try {
      const n = tradeEditRowIdx + 2; // 시트 행 번호 (A2 기준)
      await sheets.writeRange(`체결내역!A${n}:M${n}`, tradeEditValues);
      const newValues = await sheets.readRange('체결내역!A2:M');
      const newFlags  = await sheets.readTradeProcessedFlags();
      setTradeRows(newValues.map((row, i) => ({ row, processed: newFlags[i] ?? false })));
      setTradeEditOpen(false);
      setTradeEditRowIdx(null);
      setTradeSyncMsg('셀 업데이트 완료');
      setTimeout(() => setTradeSyncMsg(''), 3000);
    } catch (e) {
      setTradeSyncMsg(`저장 실패: ${e.message}`);
      setTimeout(() => setTradeSyncMsg(''), 4000);
    } finally {
      setTradeEditBusy(false);
    }
  }, [sheets, tradeEditRowIdx, tradeEditValues]);

  const applySavingsFromTrade = useCallback(async (tradeDate, amount, isBuy, tradeKey) => {
    setTradeSyncMsg('저축금 반영 중...');
    try {
      const parts = tradeDate.split('-');
      if (parts.length < 2) throw new Error('날짜 형식 오류');
      const year = parseInt(parts[0]);
      const month = parseInt(parts[1]);

      const values = await sheets.readRange('월별잔고!A2:H');
      let lastYear = 0;
      let targetRow = null;
      for (let i = 0; i < values.length; i++) {
        const r = values[i];
        const bNum = parseInt(String(r[0] ?? '').replace(/[^0-9]/g, ''));
        if (bNum >= 2000) lastYear = bNum;
        const mNum = parseInt(String(r[1] ?? '').replace(/[^0-9]/g, ''));
        if (lastYear === year && mNum === month) { targetRow = 2 + i; break; }
      }
      if (!targetRow) throw new Error(`${year}년 ${month}월 행 없음`);

      const rows = await sheets.readRange(`월별잔고!C${targetRow}:C${targetRow}`);
      const current = parseNum(rows[0]?.[0]);
      const delta = isBuy ? amount : -amount;
      await sheets.writeRange(`월별잔고!C${targetRow}:C${targetRow}`, [current + delta]);

      setSavingsAppliedRows(prev => {
        const next = new Set([...prev, tradeKey]);
        try { localStorage.setItem('banana_savings_applied', JSON.stringify([...next])); } catch { /* 저장소 불가 시 메모리만 유지 */ }
        return next;
      });
      setTradeSyncMsg(`${year}.${String(month).padStart(2,'0')} 저축금 ${isBuy ? '+' : '−'}₩${amount.toLocaleString()} 반영됨`);
      setTimeout(() => setTradeSyncMsg(''), 4000);
    } catch (e) {
      setTradeSyncMsg(`저축금 반영 실패: ${e.message}`);
      setTimeout(() => setTradeSyncMsg(''), 4000);
    }
  }, [sheets]);

  return {
    tradeRows, setTradeRows,
    tradeSyncing,
    tradeSyncMsg, setTradeSyncMsg,
    savingsAppliedRows,
    tradeEditOpen, setTradeEditOpen,
    tradeEditRowIdx, setTradeEditRowIdx,
    tradeEditValues, setTradeEditValues,
    tradeEditBusy,
    syncTradeExecutions,
    saveTradeEdit,
    applySavingsFromTrade,
  };
}
