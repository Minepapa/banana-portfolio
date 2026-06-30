// 보유종목 추가 폼. App.jsx에서 추출 (동작 불변).
// 자산군별 빈 행을 탐색(KL_CFG/buildRowMap)해 B:I열에 종목·단가·수량·수식을 onSave로 기록.
import { useState, useEffect, useCallback } from "react";
import { KL_CFG, buildRowMap } from '../lib/sheetRows.js';

export default function AddHoldingForm({ acctKey, accounts, onSave, onCancel, readRange }) {
  const assetNames = accounts[acctKey].assets.map(a => a.name);

  const [자산군, set자산군] = useState(assetNames[0] || '');
  const [종목명, set종목명] = useState('');
  const [티커유형, set티커유형] = useState('국내(GOOGLEFINANCE)');
  const [티커, set티커] = useState('');
  const [현재가수기, set현재가수기] = useState('');
  const [매수단가, set매수단가] = useState('');
  const [수량, set수량] = useState('');
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [rowMap, setRowMap] = useState(null);

  const loadRowMap = useCallback(() => {
    const cfg = KL_CFG[acctKey];
    if (!cfg) return;
    readRange(cfg.range)
      .then(rows => setRowMap(buildRowMap(rows, cfg.start, cfg.end)))
      .catch(() => setRowMap([]));
  }, [acctKey, readRange]);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setRowMap(null); loadRowMap(); }, [loadRowMap]);

  const hasAInSheet = rowMap ? rowMap.some(r => r.hasA && r.type === 자산군) : null;
  const emptySlots = rowMap ? rowMap.filter(r => r.type === 자산군 && r.empty && r.hasA).length : null;
  const sheetWarning = rowMap !== null && (!hasAInSheet || emptySlots === 0);
  const notReady = rowMap === null || saving || sheetWarning;

  const inputStyle = {
    background: '#FFFFFF', border: '1px solid #141414', borderRadius: 0,
    color: '#141414', padding: '6px 10px', fontSize: 12,
    fontFamily: "'Pretendard', -apple-system, BlinkMacSystemFont, sans-serif",
    width: '100%', boxSizing: 'border-box',
  };
  const labelStyle = { fontSize: 10, color: '#6B675C', marginBottom: 4, display: 'block' };

  const handleSubmit = async () => {
    if (!종목명.trim() || !매수단가 || !수량 || !rowMap || sheetWarning) return;
    // 자산군의 첫 번째 빈 행 찾기
    let targetRow = null;
    for (const r of rowMap) {
      if (r.type === 자산군 && r.empty && r.hasA) { targetRow = r.row; break; }
    }
    if (targetRow === null) return;
    setSaving(true);
    try {
      let 현재가formula = '';
      if (티커유형 === '국내(GOOGLEFINANCE)') 현재가formula = `=GOOGLEFINANCE("${티커}")`;
      else if (티커유형 === '해외(GOOGLEFINANCE)') 현재가formula = `=GOOGLEFINANCE("${티커}")*설정!B2`;
      else if (티커유형 === '네이버') 현재가formula = `=IMPORTXML("https://finance.naver.com/item/main.naver?code=${티커}","//p[@class='no_today']/em/span[1]")`;
      else if (티커유형 === '수기입력') 현재가formula = parseFloat(현재가수기) || 0;
      const n = targetRow;
      const 투자금 = parseFloat(매수단가) * parseFloat(수량);
      await onSave(`${acctKey}!B${n}:I${n}`, [
        종목명, parseFloat(매수단가), parseFloat(수량),
        `=C${n}*D${n}`,
        현재가formula,
        `=H${n}-E${n}`, `=D${n}*F${n}`, `=H${n}/E${n}-1`,
      ], 투자금);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 2000);
      set종목명(''); set티커(''); set현재가수기(''); set매수단가(''); set수량('');
      loadRowMap();
    } catch (e) {
      console.error('종목추가 오류:', e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{
      background: '#FFFFFF', border: '1px solid #141414', borderRadius: 0,
      padding: 16, marginBottom: 16,
    }}>
      <div style={{ fontSize: 11, letterSpacing: 2, color: '#6B675C', marginBottom: 12 }}>종목 추가</div>
      {rowMap !== null && sheetWarning && (
        <div style={{
          background: '#FBE3E4', border: '1px solid #141414', borderRadius: 0,
          padding: '7px 11px', marginBottom: 10, fontSize: 11, color: '#E5484D',
        }}>
          ⚠ {!hasAInSheet ? `시트 A열에 '${자산군}' 자산군 없음` : '빈 행 없음 — 시트에 공백 행 추가 필요'}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
        <div>
          <label style={labelStyle}>
            자산군{rowMap !== null && hasAInSheet && (
              <span style={{ marginLeft: 5, color: emptySlots > 0 ? '#6EE7B7' : '#E5484D' }}>
                ({emptySlots}개 가능)
              </span>
            )}
          </label>
          <select value={자산군} onChange={e => set자산군(e.target.value)} style={inputStyle}>
            {assetNames.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>
        <div>
          <label style={labelStyle}>종목명</label>
          <input type="text" value={종목명} onChange={e => set종목명(e.target.value)}
            placeholder="예: TIGER 미국나스닥100" style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>티커유형</label>
          <select value={티커유형} onChange={e => set티커유형(e.target.value)} style={inputStyle}>
            {['국내(GOOGLEFINANCE)', '해외(GOOGLEFINANCE)', '네이버', '수기입력'].map(o =>
              <option key={o} value={o}>{o}</option>
            )}
          </select>
        </div>
        {티커유형 !== '수기입력' ? (
          <div>
            <label style={labelStyle}>티커</label>
            <input type="text" value={티커} onChange={e => set티커(e.target.value)}
              placeholder="예: KRX:360750" style={inputStyle} />
          </div>
        ) : (
          <div>
            <label style={labelStyle}>현재가</label>
            <input type="number" value={현재가수기} onChange={e => set현재가수기(e.target.value)}
              placeholder="0" style={inputStyle} />
          </div>
        )}
        <div>
          <label style={labelStyle}>매수단가</label>
          <input type="number" value={매수단가} onChange={e => set매수단가(e.target.value)}
            placeholder="0" style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>수량</label>
          <input type="number" value={수량} onChange={e => set수량(e.target.value)}
            placeholder="0" style={inputStyle} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onCancel} style={{
          padding: '6px 14px', borderRadius: 0, border: '1px solid #141414',
          background: 'transparent', color: '#6B675C', cursor: 'pointer', fontSize: 11,
          fontFamily: "'Pretendard', -apple-system, BlinkMacSystemFont, sans-serif",
        }}>취소</button>
        <button onClick={handleSubmit} disabled={notReady} style={{
          padding: '6px 14px', borderRadius: 0, border: 'none',
          background: notReady ? '#141414' : '#141414',
          color: '#fff', cursor: notReady ? 'not-allowed' : 'pointer',
          fontSize: 11, fontFamily: "'Pretendard', -apple-system, BlinkMacSystemFont, sans-serif",
        }}>
          {saving ? '저장 중...' : success ? '저장됨 ✓' : rowMap === null ? '로딩...' : '저장'}
        </button>
      </div>
    </div>
  );
}
