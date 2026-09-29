# 체결 기록 확인 대기 큐 설계

## 목적

카카오·API 체결을 Ledger와 Holdings에 자동 반영하기 전에, 자동 판정이 불완전하거나
소스끼리 충돌한 경우 오너에게 텔레그램으로 확인을 요청한다. 오너 답장을 근거로만
기록을 재개하며, 원문·결정·기록 결과가 Vault에서 추적돼야 한다.

## 범위와 비범위

대상은 체결 원장 기록의 안전한 보류·확인·재개다. 주문 제출, 주문 정정·취소, API가
정본인 위탁·금현물 체결의 중복 기록은 바꾸지 않는다. 확인은 API 정본을 뒤집는 수단이
아니며, API 정본 체결은 계속 카카오 원문을 보관만 한다.

## 구조

`State/ExecutionConfirmations/`에 대기 건마다 Markdown 레코드 하나를 둔다. 새
`execution-confirmation-queue.mjs`는 레코드 생성·조회·상태 전이·중복 방지를 담당하는
순수 함수와 파일 I/O 경계를 제공한다. `VAULT_PATHS.state.executionConfirmations`가 이
경로의 단일 진실 소스다.

레코드는 다음 최소 필드를 가진다.

- `id`: `EC-YYYYMMDD-<난수>` 형태의 고유 ID
- `status`: `대기`, `확인됨`, `기각`, `만료`, `처리실패`
- `kind`: `account-assignment`, `duplicate-review`, `field-correction`
- `firestoreDocId`, `eventFingerprint`, `receivedAt`, `createdAt`, `updatedAt`
- 체결 스냅샷: 브로커·종목·코드·매매구분·수량·가격·체결시각·원문 해시
- `allowedAccounts`: 계좌 지정형에서만 허용되는 계좌 목록
- `reason`, `decision`, `decidedAt`, `ledgerFile`, `holdingsApplied`

frontmatter는 평평한 값만 저장한다. 배열·원문은 JSON 문자열 또는 본문 표로 보관해
`vault-frontmatter.mjs`의 중첩 객체 금지 불변식을 지킨다.

## 생성 흐름

`parse-notifications-to-vault.mjs`는 인식 가능한 체결이 다음 상태이면 기존처럼 Firestore
원문을 삭제하지 않고 큐 레코드를 만든다.

1. `account-assignment`: 계좌번호가 없고 보유 계좌가 여럿이거나 후보가 없다.
2. `duplicate-review`: API·카카오 또는 기존 Ledger와 동일성 판단이 불가능하거나 충돌한다.
3. `field-correction`: 필수 체결 필드가 누락·모순돼 안전한 Ledger 레코드를 만들 수 없다.

같은 `firestoreDocId`와 같은 `eventFingerprint`의 대기 레코드가 이미 있으면 새 레코드와
새 텔레그램을 만들지 않는다. 내용이 달라지면 새 레코드가 아니라 `updatedAt`과 본문
스냅샷만 갱신하며, 답장 전까지 자동 기록하지 않는다.

텔레그램은 표준 `formatDepartmentMessage`를 사용한다. `■ 체결`, `■ 확인 필요 사유`,
`■ 답장 형식`으로 나누고 고유 ID를 넣는다. 계좌 지정형은 후보 계좌만, 충돌형은
`기록` 또는 `무시`, 필드 보정형은 필요한 필드 이름을 보여 준다.

## 확인과 기록 흐름

텔레그램 플러그인이 `reply_to`를 항상 제공하지 않으므로, 응답은 고유 ID를 포함한 명령
형식만 허용한다.

```
체결확인 EC-20260929-ABC123 ISA
체결확인 EC-20260929-ABC123 기록
체결확인 EC-20260929-ABC123 무시
```

새 수동 CLI `resolve-execution-confirmation.mjs`는 Zeus가 동기 호출한다. CLI는 다음을
순서대로 검증한다.

1. ID가 정확히 하나의 `대기` 레코드를 가리키는지 확인한다.
2. 결정값이 `kind`에 맞고, 계좌 지정이면 `allowedAccounts` 중 하나인지 확인한다.
3. Firestore 원문이 아직 존재하며 원문 해시와 체결 지문이 대기 레코드와 같은지
   확인한다. 다르면 자동 반영하지 않고 `처리실패`로 남긴다.
4. 현재 Ledger에 동일한 체결이 이미 있는지 다시 확인한다. 있으면 원문을 삭제하지
   않고 `처리실패`로 남겨 중복을 막는다.
5. Ledger를 원자적으로 기록한 뒤에만 Firestore 원문을 삭제하고 레코드를 `확인됨`으로
   바꾼다. 이후 기존 `update-holdings-from-executions.mjs`가 `holdingsApplied:false`인
   원장을 처리한다.

`무시`는 Firestore 원문을 삭제하지 않고 레코드만 `기각`으로 바꾼다. 재검토 가능한
원본을 남기는 것이 우선이다. 같은 ID의 중복 답장·이미 처리된 답장은 아무 기록도
바꾸지 않는다.

## 실패 처리

Telegram 발송 실패는 큐 생성을 되돌리지 않는다. 다음 파서 실행에서 미발송 대기 건을
재시도하되, 성공적으로 발송된 동일 ID는 다시 보내지 않는다. Firestore·Vault 쓰기 실패는
원문을 삭제하지 않으며 `처리실패` 상태와 텔레그램 경고로 드러낸다. 원본 에러 문자열·
계좌번호는 텔레그램에 넣지 않는다.

## 테스트

- 큐 순수 함수: ID·지문 중복, 상태 전이, 허용 계좌, 잘못된 명령을 테스트한다.
- 파서 통합: 미판별 체결이 원문을 삭제하지 않고 큐 하나만 만들며, 다음 실행에서 중복
  텔레그램을 만들지 않는지 테스트한다.
- 확인 CLI: 올바른 계좌 확인만 Ledger 기록으로 이어지고, 원문 변조·중복 Ledger·중복
  답장은 모두 기록을 막는지 테스트한다.
- 기존 `execution-source-policy`, `parse-notifications-to-vault`, Telegram 형식 가드,
  전체 `npm test`와 lint를 실행한다.

## 단계

1. 큐 모듈·경로·테스트를 만든다.
2. 미판별 계좌의 생성·텔레그램 알림을 먼저 연결한다.
3. 확인 CLI와 Zeus 호출 규칙을 연결한다.
4. 중복 충돌·필드 보정 사유를 같은 큐에 추가한다.
5. Vault Implementation 기록, 독립 코드리뷰, 실제 보류 원문을 이용한 드라이런으로
   끝까지 검증한다.
