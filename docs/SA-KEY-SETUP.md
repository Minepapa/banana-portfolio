# 서비스 계정(SA) 키 배치 가이드 — 무인 자동화 잠금 해제

> 목적: launchd 자동화 잡(backfill·risk-monitor·drain 등)이 **OAuth 브라우저 팝업 없이** 시트를 읽고 쓰게 만든다. 이 1회성 설정만 끝나면 `docs/plans/ai-risk-engine.md`의 남은 라이브 작업 전부가 무인으로 풀린다.

## 동작 원리 (왜 이게 필요한가)

코드에는 인증 경로가 두 개 있다 (`scripts/lib/sheets-common.mjs`):

| 경로 | 함수 | 로그인 | 용도 |
|------|------|--------|------|
| 대화형 OAuth | `getInteractiveToken` | 브라우저 팝업 1회 | 손으로 스크립트 돌릴 때 |
| 서비스 계정 | `getServiceAccountToken` | **0회 (무인)** | launchd 무인 잡 |

서비스 계정 경로는 SA 키 JSON으로 JWT를 만들어 RS256 서명 → Google 토큰 엔드포인트와 교환한다. 이 서명 로직은 이미 오프라인 셀프테스트로 검증됨(`node scripts/tools/sa-jwt-selftest.mjs` → 14/14 통과). **남은 건 실제 키 파일을 놓고 시트를 공유하는 것뿐.**

## 사전 정보 (코드에서 확정된 값)

| 항목 | 값 |
|------|-----|
| 키 파일 기본 경로 | `~/.config/banana-portfolio/sa-key.json` |
| 경로 오버라이드 | 환경변수 `SA_KEY_FILE` |
| 필수 키 필드 | `client_email`, `private_key` (`token_uri`는 선택, 기본 `https://oauth2.googleapis.com/token`) |
| 권한 범위(scope) | `https://www.googleapis.com/auth/spreadsheets` |
| 대상 스프레드시트 ID | `1ANhZyJUm51T8HfvQ56sK-Xrli9IViKmKG462l9rLKeg` |

---

## 단계별 절차

### 1. GCP에서 서비스 계정 생성 (Google 로그인 필요)

1. https://console.cloud.google.com 접속 → 프로젝트 선택(또는 새로 만들기).
2. **API 및 서비스 → 라이브러리** → "Google Sheets API" 검색 → **사용 설정**.
3. **API 및 서비스 → 사용자 인증 정보 → 사용자 인증 정보 만들기 → 서비스 계정**.
   - 이름: 예) `banana-portfolio-bot`
   - 역할(role)은 지정 안 해도 됨 (시트는 별도 공유로 권한 부여).
4. 생성된 서비스 계정 클릭 → **키 탭 → 키 추가 → 새 키 만들기 → JSON** → 다운로드.
   - 받은 파일에 `client_email`(…@….iam.gserviceaccount.com)과 `private_key`가 들어 있다.

### 2. 키 파일 배치

```bash
mkdir -p ~/.config/banana-portfolio
mv ~/Downloads/<다운로드된키>.json ~/.config/banana-portfolio/sa-key.json
chmod 600 ~/.config/banana-portfolio/sa-key.json   # 본인만 읽기
```

> 다른 경로에 두려면 `export SA_KEY_FILE=/원하는/경로/sa-key.json` 후 잡 실행.

### 3. 스프레드시트를 SA 이메일에 공유 (Google 로그인 필요)

1. 키 파일에서 `client_email` 값을 복사:
   ```bash
   python3 -c "import json;print(json.load(open('$HOME/.config/banana-portfolio/sa-key.json'))['client_email'])"
   ```
2. 대상 시트(ID `1ANhZyJUm51T8HfvQ56sK-Xrli9IViKmKG462l9rLKeg`)를 브라우저로 열고 → **공유** → 위 이메일을 **편집자(Editor)** 로 추가.
   - 읽기만 하는 잡도 있지만, backfill·risk-monitor·drain은 시트에 쓰므로 **편집자** 필요.

---

## 검증

### 가. 오프라인 서명 검증 (로그인 불필요, 항상 가능)
```bash
node scripts/tools/sa-jwt-selftest.mjs   # 종료코드 0 = 서명/클레임 정상
```

### 나. 실제 토큰 발급 검증 (키 배치 + 시트 공유 후)
```bash
node -e "import('./scripts/lib/sheets-common.mjs').then(m=>m.getServiceAccountToken()).then(t=>console.log('토큰 발급 OK, 길이:',t.length)).catch(e=>{console.error('실패:',e.message);process.exit(1)})"
```
- "토큰 발급 OK"가 뜨면 무인 인증 성공.
- 실패 시: 키 파일 경로/형식, Sheets API 사용 설정 여부 확인.

### 다. 잡 1건 무인 실행 (dry-run 우선 권장)
```bash
# 기준선 백필 (먼저 dry-run으로 안전 확인)
node scripts/jobs/backfill-baselines.mjs --dry-run
# 실제 적재
node scripts/jobs/backfill-baselines.mjs

# 리스크 모니터
node scripts/jobs/risk-monitor.mjs --mode=D
node scripts/jobs/risk-monitor.mjs --mode=B
```
적재되면 앱 **리스크 탭**(App.jsx:2754)에서 `리스크모니터`·`리스크기준선` 데이터가 렌더되는지 확인.

---

## launchd 무인 스케줄 등록 (선택)

키 배치가 끝나면 잡을 macOS launchd에 등록해 주기 실행:
```bash
bash scripts/launchd/install.sh            # 전체 잡 설치·로드
launchctl list | grep com.banana          # 등록 확인
launchctl kickstart -k gui/$(id -u)/com.banana.risk-d   # 무인 1회 실행 테스트
```
- 각 잡은 `scripts/launchd/run.sh`가 SA 키로 토큰을 발급해 positional 인자로 주입한다.
- 실행 결과는 `잡상태` 시트에 하트비트로 기록되고, 실패 시 Telegram 알림이 온다(오늘 추가된 잡 헬스 인프라).
- 제거: `bash scripts/launchd/uninstall.sh`

---

## 트러블슈팅

| 증상 | 원인 / 조치 |
|------|-------------|
| `SA 키에 client_email/private_key 없음` | 키 JSON이 손상됐거나 다른 파일. 3단계 재다운로드 |
| 토큰 발급은 되는데 시트 읽기/쓰기 403 | 시트를 SA `client_email`에 편집자 공유 안 함 (3단계) |
| `무인 토큰 없음: 서비스 계정 키 필요` | 키 파일이 기본 경로에 없음. 2단계 또는 `SA_KEY_FILE` 확인 |
| launchd 잡이 조용히 안 돎 | `~/Library/Logs/banana-portfolio/<job>.log` 확인, `잡상태` 시트 점검 |

## 보안 메모
- `sa-key.json`은 **절대 git에 커밋 금지** (private_key 포함). `~/.config` 아래 두고 `chmod 600`.
- 키 유출 시 GCP 콘솔에서 해당 키 삭제 → 새 키 발급 → 재배치.
