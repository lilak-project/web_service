# LILAK handshake 규약

LILAK에서 두 프로그램이 처음 서로를 알아보는 방법은 모두 **handshake**입니다.
지금 세 가지가 있고, 하는 일은 다르지만 모양은 같습니다. 새 연결을 만들 때도 이 모양을 따르세요.

| | 누가 → 누구에게 | 무엇을 정하나 | 구현 |
|---|---|---|---|
| **A. 장비 등록** | elog → 장비 서비스 | 서비스 이름과 기록할 항목(log_fields) | `lilak_elog/backend/routes/services.py`, 각 서비스의 `backend/app/elog.py` |
| **B. 서비스 등록** | 서비스 → 포털 | 포털 카드(매니페스트) | `service_manager/app/routers/services.py` `/api/handshake` |
| **C. 서버 간 연결** | 포털(sub) ↔ 포털(main) | 동기화 연결과 토큰 | `service_manager/app/routers/sync.py` |

## 1. 공통 모양

1. **주소 하나로 시작합니다.** 사람이 넣는 것은 상대 주소뿐입니다. 이름·항목·토큰은 handshake가 알아냅니다.
2. **POST 한 번, JSON 하나.** 요청은 JSON 객체이고, 무엇을 묻는지는 `"event"` 로 말합니다
   (`"<보내는 쪽>_handshake"`, 예: `elog_handshake`). 답도 JSON 객체 하나입니다.
3. **답은 "나는 누구고 무엇을 할 수 있다"입니다.** 이름(`name`), 설명(`description`), 사람이 읽을 기계 이름(`hostname`),
   그리고 연결마다 필요한 목록(A는 `log_fields`, B는 `kind`·`mode`·`capabilities`, C는 프로젝트).
4. **비밀은 한 번만, 정해진 방향으로만 갑니다.** 토큰은 화면에 보이지 않고, 받는 쪽만 저장합니다.
   한 번 넘겨준 토큰은 보낸 쪽 기록에서 지웁니다(C). 새면 **재발급** — 예전 것은 바로 막힙니다.
5. **다시 해도 됩니다(멱등).** 같은 handshake를 다시 하면 등록이 새로 생기지 않고 갱신됩니다
   (A의 rehandshake, B의 재등록, C의 재연결).
6. **빨리 답합니다.** 묻는 쪽은 5초(A) ~ 10초(C) 뒤 포기합니다. 장비를 붙잡고 기다리지 말고 이미 아는 것으로 답하세요.
7. **실패는 이유를 말합니다.** `{"detail": "…"}` 와 맞는 HTTP 코드(400 형식, 401/403 권한, 404 없음, 409 상태 충돌,
   503 지금은 못 함). 묻는 쪽은 그 문장을 그대로 사람에게 보여 줍니다.
8. **모르는 event 는 거절합니다** (400). 엉뚱한 요청에 데이터로 답하는 것보다 낫습니다.

## 2. A — 장비 등록 (elog → 서비스)

elog의 New Service 에서 주소만 넣고 **Discover** 를 누르면:

```http
POST <서비스 주소>            # 포털이 띄운 서비스는 portal://<이름>/<경로>
{"event": "elog_handshake", "elog_url": "http://elog-server:8000"}
```

```json
{
  "name": "Vacuum Monitor",
  "description": "RGA + ion gauge readout",
  "hostname": "vacuum01.lab.local",
  "directory": "/opt/vacuum",
  "is_system": false,
  "log_fields": [
    {"key": "pressure_ch1", "label": "Pressure Ch1", "type": "number_entry", "unit": "Torr", "metric": true},
    {"key": "body", "label": "Summary", "type": "body"}
  ]
}
```

- `type`: `number_entry · number · text · select(options) · body · title · tags · level`.
  `metric: true` 인 숫자는 Infography 변수가 됩니다.
- **필드 목록은 설정에서 나와야 합니다** — 지금 꽂혀 있는 장비에서 나오면 케이블 하나에 포맷이 갈라집니다.
- 같은 주소로 오는 `event` 없는 요청이 실제 값 요청이고, 답은 `{"fields": {...}}` 입니다.
- 스스로 기록을 보내는 *system* 은 이어서 `{"event": "elog_credentials", "elog_url", "elog_token"}` 을 받아 저장합니다.
- 서비스마다 `backend/app/elog.py` 를 **복사해** 둡니다(공용 import 아님). 서비스를 폴더 하나로 옮길 수 있어야 해서입니다
  (SERVICE_CONTRACT §9). 고칠 때는 사본들을 같이 맞추세요.

## 3. B — 서비스 등록 (서비스 → 포털)

서비스가 스스로 포털에 카드를 만듭니다. 포털 관리자가 Handshake 탭에서 주소와 등록 토큰을 복사해 줍니다.

```http
POST <포털>/api/handshake
Authorization: Bearer <PORTAL_REGISTER_TOKEN>
{"name": "hv", "kind": "service", "mode": "external", "url": "http://hv01:8030",
 "accepts_portal_token": true, "multi_project": false}
```

`{"ok": true, "name": "hv", "updated": false, "entry": "<포털>/p/hv/"}` — 다시 보내면 갱신(`updated: true`).
`PORTAL_REGISTER_TOKEN` 을 정하지 않은 포털은 503 으로 거절합니다(기본값으로 아무나 등록하지 못하게).

## 4. C — 서버 간 연결 (sub 포털 ↔ main 포털)

한 서비스(또는 그 프로젝트 하나)를 다른 서버와 동기화하는 연결입니다. 두 가지 길이 있습니다.

### 4.1 주소로 요청하고 main 이 승인 (기본)

```text
sub 관리자      동기화 → main 연결: 주소(+ 프로젝트, 양방향)  → [연결 요청]
  sub → main    POST /api/sync/<svc>/requests
                {"project", "two_way", "from_url", "from_name", "by"}      (인증 없음)
  main → sub    {"id", "claim", "pin": "548-125"}                         ← claim 은 sub 만 압니다
main 관리자     같은 화면에 "연결 요청 · kiki.local · boss · 프로젝트 other · 확인 번호 548-125"
                확인 번호가 sub 화면과 같은지 보고 [승인] (양방향 허용 체크)
  sub → main    GET /api/sync/<svc>/requests/<id>?claim=…                 (몇 초마다, 20초마다 백그라운드)
  main → sub    {"status": "approved", "token": "…", "two_way": true}     ← 토큰은 이때 한 번만
sub             프로젝트가 없으면 만들고, 연결을 저장하고, 첫 동기화
```

- **승인 전에는 아무것도 열리지 않습니다.** 요청은 대기 20개까지, 7일 지나면 사라집니다. 글자 칸은 잘라서 저장합니다.
- **확인 번호(pin)** 는 claim 에서 나온 6자리입니다. 누가 같은 요청을 흉내 내도 번호가 다르므로, 승인 전에 sub 쪽 사람에게
  번호를 확인하세요.
- 승인하면 main 은 그 연결(프로젝트 것 또는 서비스 것)의 main 이 됩니다. 이미 다른 서버를 따르는 사본은 원본이 될 수 없습니다(409).
- 토큰은 sub 가 받아 가는 순간 main 의 요청 기록에서 지워집니다. 거절은 sub 화면에 "거절됨"으로 나옵니다.

### 4.2 연결 코드 (main 이 먼저 줄 때)

main 의 동기화 화면에 나오는 `lilak-sync:…` 한 줄 = url-safe base64 JSON
`{"v": 1, "url", "svc", "proj"?, "token", "two_way"}`. sub 에서 같은 칸(main 연결)에 붙여넣고 **받기** →
`POST /api/admin/services/<svc>/sync/join` 이 4.1 의 마지막 줄과 같은 일을 합니다.
코드에는 토큰이 들어 있으니 비밀번호처럼 다루세요.

### 4.3 연결 뒤에 오가는 것

토큰 범위: 서비스 토큰은 따로 연결된 프로젝트를 빼고 전부, 프로젝트 토큰은 그 프로젝트만 엽니다.
`/api/sync/<svc>/projects · stamps · projects/<p>/manifest · file (GET/PUT/DELETE)` — 자세한 동작은 `DEPLOYMENT.md` §9.

## 5. 새 handshake 를 만들 때

- event 이름은 `<묻는 쪽>_handshake`, 비밀을 건네는 두 번째 event 가 있으면 `<묻는 쪽>_credentials`.
- 답에는 최소 `name`, `description`, `hostname`. 나머지는 그 연결에 꼭 필요한 것만.
- 인증 없이 받는 요청은 **아무 권한도 주지 않아야** 하고(C 의 요청처럼), 저장한다면 개수·기간·크기를 제한합니다.
- 토큰을 사람 눈에 보여 줘야 하는 설계라면 다시 생각하세요 — 승인 + claim 이나 코드로 대신할 수 있습니다.
- 묻는 쪽 화면은 "누구에게 무엇을 물었고, 무엇이 왔는지"와 실패 이유를 그대로 보여 줍니다.

---

**English summary** — every first contact in LILAK is a handshake: one POST of a JSON object whose `"event"`
names the question, answered with one JSON object saying who the service is and what it offers. Only an
address is typed; secrets travel once, in one direction, and are never shown; repeating a handshake updates
rather than duplicates; failures carry `{"detail"}` with a fitting status. Three exist: **A** elog → device
service (`elog_handshake` → `log_fields`, then `elog_credentials` for systems), **B** service → portal
(`/api/handshake` with the register token), **C** portal ↔ portal sync — a sub asks by address
(`POST /api/sync/<svc>/requests`, no credentials), main's admin approves after matching the six-digit pin,
and the sub collects the token once with its private claim; or main hands over a `lilak-sync:` code.
