# Deployment & Security / 배포 및 보안

This document explains how the LILAK Web Portal handles **accounts, passwords, and
personal data**, and the checklist to harden it **before running it officially**
(e.g. on a company server with a public web address, where a security team may
review it). Korean and English are kept side by side.

이 문서는 LILAK 웹 포털이 **계정·비밀번호·개인정보**를 어떻게 다루는지, 그리고
**정식 운영 전**(예: 회사 서버·공개 웹주소, 보안팀 심사 대상) 반드시 잠가야 할
항목을 정리합니다. 한국어와 영어를 나란히 둡니다.

---

## 1. What personal data is collected / 수집하는 개인정보

**한국어** — 포털이 저장하는 개인정보는 최소한입니다:

| 항목 | 용도 | 위치 |
|---|---|---|
| 아이디(username) | 로그인 식별자 | `data/_portal/portal.db` |
| 이메일(email) | 가입 인증·비번 재설정·중복 방지 | 동일 |
| 표시 이름(display_name) | 화면 표시 | 동일 |
| 프로필 색/아이콘 | 아바타 | 동일 |
| 비밀번호 **해시** | 로그인 검증 (원문 아님) | 동일 |

DB(`portal.db`)는 코드 저장소 밖(`~/web_service/data/`)에 있고 gitignore됩니다. 처리방침에는
위 목록·보관기간·삭제 방법(계정 삭제 API `DELETE /api/account` 존재)을 명시하면 됩니다.

**English** — the portal stores a minimal set: `username`, `email`,
`display_name`, an avatar colour/icon, and a **password hash** (never the plaintext).
All of it lives in `data/_portal/portal.db`, which sits **outside** the code repos and
is gitignored. Your privacy policy only needs to cover this short list, its retention,
and deletion (a self-service `DELETE /api/account` exists).

---

## 2. Passwords: can an admin see them? / 비밀번호를 관리자가 볼 수 있나?

**No — by construction. / 아니오 — 구조적으로 불가능.**

- Passwords are stored as **bcrypt** hashes (salted, slow, one-way) —
  `app/security.py`. The plaintext is never written anywhere.
  비밀번호는 **bcrypt 해시**(salt+단방향)로만 저장됩니다. 원문은 어디에도 기록되지 않습니다.
- **No endpoint returns the password or its hash.** The admin user list serialises
  only `username / email / role`.
  **비밀번호나 해시를 반환하는 엔드포인트가 없습니다.** 관리자 목록도 `아이디/이메일/역할`만 내보냅니다.
- Opening the DB file directly still shows only the bcrypt hash — the original
  password cannot be recovered.
  DB를 직접 열어도 bcrypt 해시만 보이며 원문 복원은 불가능합니다.

Legacy `sha256:salt:digest` hashes still verify and are transparently upgraded to
bcrypt on the next login.
기존 `sha256` 해시도 검증되며 다음 로그인 시 bcrypt로 자동 업그레이드됩니다.

---

## 3. Password reset — without the admin knowing? / 비밀번호 초기화 — 관리자 모르게?

There are three paths. Only the **self-service** one is fully admin-blind.
경로는 3가지이며, **본인 변경**만 관리자에게 완전히 보이지 않습니다.

| Path / 경로 | Endpoint | Does the admin learn it? / 관리자가 아나? |
|---|---|---|
| Self change (old + new) / 본인 변경 | `POST /api/account/password` | ❌ No — admin is not involved / 개입 없음 |
| Admin sets a value / 관리자 지정 | `POST /api/admin/users/{id}/password` | ⚠️ Admin knows that temporary value / 임시값을 앎 |
| Admin email reset / 관리자 이메일 재설정 | `POST /api/admin/users/{id}/reset-password-email` | ❌ In production, emailed straight to the user / 사용자에게 직접 발송 |

**한국어** — "관리자 모르게"가 필요하면 사용자가 **본인 변경**을 쓰면 됩니다. 관리자가 개시하는
이메일 재설정은 랜덤 비번을 만들어 **사용자 메일로 바로 발송**하도록 되어 있어(§5 설정 시) 관리자가
값을 보지 않습니다. 단, 아래 **dev echo가 켜져 있으면**(로컬 개발 기본값) 그 값이 응답에 함께
돌아오므로, 운영에서는 반드시 꺼야 합니다(§4).

**English** — for a truly admin-blind reset, the user uses **self change**. The
admin-initiated email reset generates a random password and **emails it directly to
the user** (once §5 is configured), so the admin never sees it — **except** while
dev echo is on (the local-dev default), which also returns the value in the API
response. Turn it off in production (§4).

---

## 4. Production hardening checklist / 운영 배포 하드닝 체크리스트

Set these environment variables before exposing the portal publicly. The portal
**prints a `[SECURITY]` banner at startup** listing whichever of these are still in
their insecure dev state (see `app/main.py` → `_security_preflight`).

공개 배포 전 아래 환경변수를 설정하세요. 포털은 **기동 시 `[SECURITY]` 배너**로 아직 개발 상태로
남아있는 항목을 로그에 출력합니다.

| Env var / 환경변수 | Dev default / 개발 기본 | Production / 운영 | Why / 이유 |
|---|---|---|---|
| `PORTAL_SECRET_KEY` | *(public dev secret)* | **strong random** (`openssl rand -hex 32`) | JWT signing; a known key ⇒ forgeable tokens / 토큰 위조 방지 |
| `EMAIL_VERIFY_DEV_ECHO` | on (local only) | **`0`** / auto-off | Stops codes & reset passwords leaking in API responses / 코드·비번 응답 노출 차단 |
| `PORTAL_ALLOWED_ORIGINS` | `*` | `https://portal.example.org` | Lock CORS to your domain / CORS 도메인 제한 |
| `PORTAL_BASE_URL` | `http://localhost:8025` | `https://…` | Serve over TLS; enables `Secure` cookie / TLS 및 Secure 쿠키 |
| `PORTAL_PASSWORD_MIN_LENGTH` | `8` | `8`+ | Minimum length on set / 설정 시 최소 길이 |
| `PORTAL_REGISTER_TOKEN` | disabled | set only if using self-registration / 자가등록 쓸 때만 | Service self-registration bearer |
| `RESEND_API_KEY` + `RESEND_FROM_EMAIL` | unset | **set** | Real email delivery (§5) / 실제 메일 발송 |

**Safety net / 안전장치**: `EMAIL_VERIFY_DEV_ECHO` auto-disables whenever
`PORTAL_SECRET_KEY` is set and `PORTAL_BASE_URL` is not localhost — so a real
deployment cannot leak codes even if the operator forgets the flag. An explicit env
value always wins.
`PORTAL_SECRET_KEY`가 설정되고 `PORTAL_BASE_URL`이 localhost가 아니면 dev echo는 **자동으로 꺼집니다**.
운영자가 깜빡해도 코드가 새지 않습니다. 명시적 환경변수 값이 있으면 그 값이 우선합니다.

Also handled / 추가 반영:
- Responses are **gzip-compressed** (`GZipMiddleware`) — the ~1.7 MB cover-UI bundle
  transfers at ~460 KB. / 응답 gzip 압축으로 번들 전송량 대폭 감소.
- The token cookie gains `Secure` automatically when served over HTTPS. / HTTPS에서 토큰 쿠키에 `Secure` 자동 부여.

---

## 5. Email delivery (Resend) / 이메일 발송 (Resend)

The portal sends verification codes and password-reset emails via
[Resend](https://resend.com) (`app/emailer.py`). Configure:
포털은 인증 코드·비번 재설정 메일을 Resend로 보냅니다. 설정:

```bash
export RESEND_API_KEY="re_xxx"
export RESEND_FROM_EMAIL="portal@your-verified-domain.org"
export RESEND_REPLY_TO="admin@your-org.org"   # optional / 선택
```

Without these, email flows fall back to dev echo (local only) or error out in
production. Verify your sending domain in Resend first.
설정이 없으면 로컬에선 dev echo로, 운영에선 오류로 처리됩니다. Resend에서 발신 도메인 인증을 먼저 하세요.

---

## 6. Third-party services (Indico, wiki engines) / 서드파티 서비스 (Indico, 위키 등)

**한국어** — Indico(CERN), MediaWiki 같은 엔진은 **완전히 별개의 애플리케이션**입니다. 각자
자기 계정 시스템·자기 DB·자기 개인정보 처리방침을 가집니다. 포털에 붙이더라도:

- 포털은 `managed`(서브프로세스) 또는 `external`(원격 URL) 어댑터로 **프록시**만 합니다
  (`SERVICE_CONTRACT.md` 참고). SSO로 넘어가는 것은 **신원(이메일/이름)**뿐입니다.
- 그 앱 안에 쌓이는 데이터(글·첨부·접속 로그·자체 회원정보)는 **그 앱이 자기 정책대로** 저장합니다.
- 따라서 회사 심사는 **포털 + 각 서드파티 앱을 별도로** 봐야 하며, 엔진마다 자체 약관·개인정보
  검토가 필요합니다. (Indico는 GDPR/개인정보 기능이 내장되어 있으니 켜서 설정하세요.)
- SSO로 **어떤 개인정보를 그 앱에 넘기는지**(`identity.accepts_portal_token`, `link_by`)도 검토 대상입니다.

**English** — engines like Indico or MediaWiki are **separate applications** with
their own accounts, storage, and privacy policies. The portal only **proxies** them
(`managed` = subprocess, `external` = remote URL) and can pass **identity (email/name)**
via SSO — but everything stored inside that app is governed by **its own** policy.
A company review must therefore treat the **portal and each third-party app
separately**, and each engine needs its own terms/privacy assessment. Check what
identity fields SSO forwards (`identity.accepts_portal_token`, `link_by`).

---

## 7. Quick production start / 운영 기동 예시

```bash
export PORTAL_SECRET_KEY="$(openssl rand -hex 32)"
export PORTAL_BASE_URL="https://portal.your-org.org"
export PORTAL_ALLOWED_ORIGINS="https://portal.your-org.org"
export RESEND_API_KEY="re_xxx"
export RESEND_FROM_EMAIL="portal@your-org.org"
# EMAIL_VERIFY_DEV_ECHO auto-off here (secret set + non-localhost base url)

cd service_manager && ./run.sh   # check the startup logs show NO [SECURITY] warnings
```

Serve behind a TLS-terminating reverse proxy (nginx/Caddy). Confirm the startup log
prints **no** `[SECURITY]` warnings.
TLS 종단 리버스 프록시(nginx/Caddy) 뒤에 두고, 기동 로그에 `[SECURITY]` 경고가 **없는지** 확인하세요.

---

## 8. Portal-only install / 포털만 설치하기

**한국어** — 서비스를 전부 미리 받을 필요는 없습니다. **포털만 설치**하고, 나중에 홈의
**서비스 매니저** 카드에서 필요한 것만 골라 설치할 수 있습니다.

```sh
git clone https://github.com/lilak-project/web_service.git   # --recursive 없이
```

그다음 관리자로 로그인 → 홈의 **서비스 매니저** 카드를 열면:

- **설치** — 카탈로그의 서비스를 `git clone` → 빌드 → 등록합니다. 진행 로그가 실시간으로
  보이고, 끝나면 홈에 그 서비스 카드가 나타납니다. 공용 UI 킷(`lilak_ui`)이 없으면 먼저
  자동으로 받습니다.
- **업데이트** — 이미 설치된 서비스를 `git pull --ff-only` 후 다시 빌드합니다. ff-only라
  로컬 변경이나 분기가 있으면 덮어쓰지 않고 실패합니다(직접 정리 후 재시도). 실행 중인
  서비스는 반영을 위해 재시작하세요.
- **포털 빌드** — 포털 프론트엔드를 다시 빌드합니다(`git pull --ff-only` 옵션). 빌드 후
  새로고침하면 반영됩니다.

설치가 도중에 실패하면 **이번에 받은** 코드 디렉터리는 지워지므로 그대로 다시 시도할 수
있습니다. 원래 있던 체크아웃은 건드리지 않습니다.

카탈로그는 `service_manager/app/store_catalog.json` 입니다. 항목마다 `repo`, 선택적으로
`branch`(기본 브랜치가 아닌 경우), `private`(비공개 레포 — 서버에 SSH 키 필요)를 둡니다.
매니페스트는 `deploy/seed/<name>/service.json` 을 그대로 쓰되 컨테이너 경로(`/app/...`)를
이 서버 경로로 바꿔 기록하므로, `start.cwd` 를 손으로 고칠 필요가 없습니다.

**필요한 것**: 서버에 `git` + Node(`npm`). 현재 카탈로그는 전부 공개 레포라 GitHub 자격증명
없이 설치됩니다.

**English** — you do not need to fetch every service up front. Install the **portal
alone** (clone without `--recursive`), then pick services later from the **Service
Manager** card on Home:

- **Install** — `git clone` → build → register a catalog service, with a live log;
  its card appears on Home when the job finishes. The shared UI kit (`lilak_ui`) is
  fetched automatically if absent.
- **Update** — `git pull --ff-only` an installed service, then rebuild. ff-only, so
  local edits or a diverged branch fail the job rather than being overwritten;
  restart the service to pick the update up.
- **Build portal** — rebuild the portal frontend (optionally `git pull --ff-only`
  first); refresh the page afterwards.

A failed install deletes the checkout **it** created, so you can just retry; a
checkout that was already there is left alone.

The catalog is `service_manager/app/store_catalog.json`: each entry has a `repo`,
optionally `branch` (when the portal-ready code is not on the default branch) and
`private` (needs an SSH key on the server). Manifests come from
`deploy/seed/<name>/service.json` with container paths (`/app/...`) re-rooted at this
server's stack directory, so there is no `start.cwd` to fix up by hand.

**Requires** `git` + Node (`npm`) on the server. Every current catalog entry is a
public repo, so no GitHub credentials are needed.

> **Create service** (the other admin card) also works on a portal-only checkout —
> it fetches the kit the same way.
> **Create service**(서비스 만들기) 카드도 포털만 받은 상태에서 동작합니다 — 킷을 같은
> 방식으로 받아옵니다.

---

## 9. Mirroring a service across servers / 서버 간 서비스 동기화

**한국어** — 서로 다른 서버의 포털끼리 **서비스 단위로** 데이터를 미러링할 수 있습니다.
예: `s2`의 elog를 원본으로 두고 `s1`이 사본을 유지, 동시에 `s3`의 asset_manager를
`s1`이 미러링. 설정은 **관리 모드 → 서비스 카드 → 동기화** 에 있습니다.

**설정 순서**

1. **원본 서버(main)** — 해당 서비스에서 역할을 `main (원본)`으로 바꾸면 **주소 + 토큰**이
   나옵니다. (토큰이 새면 데이터가 통째로 읽히므로 채팅 등으로 흘리지 마세요. 유출 시
   `재발급` — 연결된 sub는 다시 연결해야 합니다.)
2. **사본 서버(sub)** — 같은 이름의 서비스에서 역할을 `sub (미러)`로 바꾸고 주소·토큰을
   붙여넣습니다. `읽기 전용으로 잠그기`는 켜 두는 것을 권합니다.
3. `자동`에서 주기를 고르고(수동만 / 1 / 5 / 15 / 60분) **연결 저장**. `지금 동기화`로
   즉시 한 번 받을 수도 있습니다.

**동작 방식**

- **sub가 가져갑니다(pull).** main은 sub 주소를 몰라도 되고, sub만 main에 닿으면 됩니다.
- **바뀐 파일만** 전송합니다(파일별 SHA-256 비교). 변경이 없으면 0바이트입니다.
- SQLite는 **일관 스냅샷**(backup API)으로 뜹니다 — 서비스가 쓰는 중이어도 안전합니다.
- main에서 지워진 파일은 sub에서도 지워집니다. 다만 **main에 없는 프로젝트는 그대로 둡니다** —
  미러는 추가·갱신만 하고 프로젝트를 통째로 삭제하지 않습니다.
- **sub의 수정은 다음 동기화 때 사라집니다.** 그래서 읽기 전용 잠금이 기본이며, 켜져 있으면
  프록시가 쓰기 요청(GET/HEAD 외)을 403으로 막습니다.

**계정과 권한**

계정은 **서버마다 독립**입니다. 동기화되는 것은 프로젝트 데이터뿐이고, 매니저 권한도 각
서버에서 따로 관리합니다. 미러를 처음 받으면 sub에는 그 서비스를 쓸 수 있는 사람이
없으므로, **동기화 → 권한** 에서:

- `main 권한 확인` — main의 권한을 이 서버 계정과 대조해 **미리보기**만 합니다
  (아이디 우선, 없으면 이메일로 매칭. 이메일로만 맞거나 이메일이 다르면 표시됩니다).
- `이 서버 계정에 적용` — 확인 후 실제로 부여합니다. 이 서버에 계정이 없는 사람은
  **건너뜁니다(계정을 만들지 않습니다)**. 여러 번 눌러도 중복되지 않습니다.

권한 이전은 **관리자가 직접 누를 때만** 일어납니다 — 데이터 동기화가 권한을 옮기는 일은
없습니다.

**한계** — 지금은 단방향(main → sub)입니다. 양쪽에서 수정한 내용을 합치는 머지는 각
서비스의 스키마에 전역 고유 ID가 필요해 아직 없습니다. 양쪽에서 쓰고 싶다면 서비스(또는
프로젝트)마다 주인을 나누고 서로 반대 방향으로 미러링하세요.

**English** — portals on different servers can mirror a service's project data:
`s2`'s elog as the source with `s1` keeping a copy, while `s1` also mirrors
`s3`'s asset_manager. Configure it under **manage mode → service card → Sync**.

1. On the **source**, set the role to `main` — it shows a **URL + token** (treat the
   token as a secret: it grants a full read of that service's data; `Rotate` if it
   leaks, then re-pair every sub).
2. On the **mirror**, set the role to `sub`, paste both, and keep `lock read-only` on.
3. Choose an `Auto` interval (manual / 1 / 5 / 15 / 60 min) and **Save link**;
   `Sync now` pulls immediately.

How it behaves: the **sub pulls** (main never needs to reach it); only files whose
SHA-256 differs are transferred (an unchanged project costs zero bytes); SQLite is
copied as a consistent snapshot, safe while the service is running; files deleted on
main are deleted on the sub, but **projects absent on main are left alone**; and
edits made on a sub are discarded by the next pull — hence the read-only lock, which
makes the proxy refuse anything other than GET/HEAD.

Accounts are **per-server** and never synced, so a fresh mirror has nobody able to
use it. Under **Sync → Grants**, `Check main` previews main's grants matched against
local accounts (by username, else email — email-only and mismatched-email matches are
flagged), and `Apply here` grants them. People without a local account are skipped —
this never creates accounts — and re-applying is a no-op. It runs only when an admin
asks; a data sync never moves permissions.

**Limitation** — one-way (main → sub) only. Merging edits made on both sides needs a
globally unique id in each service's schema and does not exist yet; to write on both
servers, split ownership per service (or per project) and mirror in opposite
directions.
