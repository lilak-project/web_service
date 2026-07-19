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
