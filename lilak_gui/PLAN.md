# lilak_gui — 개발 주문서 (LILAK GUI service)

> ⚠️ **방향 전환 (2026-06-30):** 기존 LILAK 웹 UI(`~/Research/lilak/ui/`)를 **재사용하지
> 않고 처음부터 새로 만든다.** (기존 UI 디자인이 마음에 안 듦.) 아래 §2 의 "이미 있는
> UI 재사용" 전제는 **폐기** — §2 는 "LILAK 이 뭘 노출하는지"의 참고자료로만 본다.
>
> **결정/현황:** 스택 = `lilak_ui` 키트 기반 React 프론트(참고 모델 `lilak_elog`) +
> FastAPI 백엔드, **메인 테마색 보라**. **지금까지: elog식 보라 탭 셸 + 4개 placeholder
> 탭(실행/파라미터/뷰어/설정)**을 만들고 포탈 통합(base-path/SSO/`$LILAK_PATH`)까지
> end-to-end 검증 완료. 각 탭의 실제 기능은 앞으로 하나씩 채운다. 포탈 통합 계약
> (§3~§8)은 그대로 유효.

> 이 문서 하나로 새 대화에서 개발을 이어갈 수 있게 쓴 명세서입니다. 포탈
> (`service_manager`) 통합이 전제. 지금은 **폴더 + placeholder + 포탈 등록**까지만
> 되어 있고 실제 구현은 안 했습니다.

## 0. 한 줄 요약
기존 **LILAK** 분석 프레임워크를 웹 **GUI**로 쓰는 포탈 서비스. `$LILAK_PATH` 로 LILAK을
찾아서 그 기능들(파라미터 편집, run 실행, ROOT 결과 뷰 등)을 웹에서 조작한다.

## 1. 이름 / 서비스 ID
- 서비스 id (폴더·URL): **`lilak_gui`**
- 포탈 매니페스트: `data/lilak_gui/service.json` (이미 등록됨 — 지금은 placeholder 정적 서빙)
- 진입 경로: `/p/lilak_gui/` (단일 서비스 프록시)
- 코드 위치: `~/web_service/lilak_gui/`

## 2. ★ 가장 중요한 출발점 — 이미 있는 LILAK 웹 UI를 재사용
**바닥부터 만들지 말 것.** LILAK 웹 UI가 이미 있다:
- 위치: `/Users/jungwoo/Research/lilak/ui/`
- 스택: **FastAPI 백엔드(포트 8110, venv `ui/backend/.venv`) + React/Vite/Tailwind/JSROOT
  프론트(dev 5110)**. `ui/start.sh` (prod) / `ui/start.sh dev`.
- **lilak-ui 키트 셸 + 6탭**: `run` / `parameter` / `flow` / `mapping` / `jsroot` / `setting`.
  - run = RunControl, parameter = ParameterEditor(`lilak par` 풀 포팅), jsroot = RootViewer.
  - flow/mapping 은 placeholder (lilak_configure_flow_editor.py / lilak_si_mapping_editor.py 포팅 예정).
  - setting = ColorSettings.
- LILAK run 실행: **`bash -c 'source macros/command_lilak.sh && lilak run_web <config>'`**
  (`run_web` = 배치 모드 `root -l -b -q -n`. 그냥 `lilak run` 은 인터랙티브 → 서브프로세스 hang 주의).
- **ROOT 파일 서빙**: 직접 만든 HTTP Range(멀티파트 byteranges 포함) 지원 — JSROOT 부분읽기에 필요.
- **JSROOT/Vite 함정**: dev `optimizeDeps.exclude: ['jsroot']`, build `rollupOptions.external` 에
  jsroot의 node 전용 `@resvg/*.node` 류 넣어야 함. 프론트는 react-markdown+remark-gfm 필요(키트가 import).
- 참고: 사용자 todo `/Users/jungwoo/Research/lilak/todo_list.md`, 포트 레지스트리 `~/ai_projects/PORTS.md`.

→ **할 일 = 이 UI를 포탈 서비스로 통합**하는 것이지 새로 짜는 게 아니다. (lilak_elog/asset_manager를
`~/web_service/` 로 가져와 포탈화한 것과 같은 패턴.)

## 3. $LILAK_PATH 로 LILAK 찾기
- 기존 UI는 LILAK 경로가 하드코딩/상대 가정일 수 있음. **`$LILAK_PATH` 환경변수로 LILAK 루트를
  찾도록** 일반화한다 (`$LILAK_PATH/macros/command_lilak.sh` 등). 매니페스트 `start.env` 에
  `LILAK_PATH` 를 주입(서버마다 다를 수 있으니 env로). LILAK 미설치 시 친절한 안내.

## 4. 포탈 통합 계약 (반드시)
포탈 `SERVICE_CONTRACT.md` / `AI_SERVICE_GUIDE.md` 규칙.
- **단일 서비스** (`multi_project=false`). 진입 `/p/lilak_gui/`.
- **SSO** (`accepts_portal_token=true`): 진입 시 포탈 JWT 를 Authorization 헤더(+`lilak_portal_token`
  쿠키)로 전달. 백엔드는 공유 시크릿(`ELOG_SECRET_KEY`)으로 검증, `email`/`username` 으로 사용자 식별.
- **base-path 인식**: 프록시 뒤(`/p/lilak_gui/`)에서 동작 — Vite `base:'./'`, `index.html`
  `<base href="/">`(포탈이 덮음), 모든 API/asset 은 `window.__PORTAL_BASE__` 기준 상대경로,
  React Router `basename`. (elog/asset_manager와 동일. **ROOT Range 서빙 경로도 base 아래로.**)
- **가시성**: 기본 protected(2) 로 등록됨 — 무거운 분석이면 private(1)로 바꿔 권한자만(포탈 Services 화면).
- **health**: `GET /` 또는 `/api/health`.

## 5. 실행 환경 (Docker / toolchain)
- LILAK 는 ROOT 기반 + 빌드된 라이브러리. ROOT/LILAK 은 무거우니 **포탈 이미지에 넣지 말 것.**
- 권장: **external 서비스(별도 컨테이너)** — ROOT+LILAK 이미지 위에서 lilak_gui 백엔드 실행, 자체
  포트(예 8060), compose에 별도 서비스로 추가, 포탈에 `mode=external, url=http://lilak_gui:8060,
  accepts_portal_token=true` 로 재등록. (지금은 임시 managed+placeholder.)
- 대안(로컬 개발): managed 로 `start.cmd` = UI 백엔드 실행, `start.env.LILAK_PATH` 주입, cwd = UI 백엔드.

## 6. 멀티유저 / 자원 고려 (LILAK run은 무겁다)
- run 실행은 g4toy 와 비슷한 고민이 있다: 동시에 여러 run 이 서버를 잡으면 안 됨 →
  **잡 큐(한 번에 하나, 순서대로, 타임아웃)** 권장. (g4toy/PLAN.md §4.2,§7 참고 — 동일 패턴 재사용 가능.)
- 사용자별 작업공간(`data/lilak_gui/users/<user_key>/`) + 결과/설정 격리 + 용량 제한.
- 단, 1차 MVP는 기존 UI 그대로 포탈에 얹고 SSO/base-path만 맞추는 것으로 시작해도 됨(큐는 후속).

## 7. 기능(기존 UI 기준) → 포탈에서 그대로
- **run**: config 선택 → `lilak run_web` 배치 실행 → 로그/결과.
- **parameter**: `lilak par` 편집기(파서는 `ui/backend/services/parameter_parser.py`, 원본과 round-trip
  동일 검증됨 — 원본 바뀌면 재싱크).
- **jsroot**: 결과 .root 를 JSROOT 로 웹 임베드(Range 서빙).
- **flow / mapping**: lilak_configure_flow_editor.py / lilak_si_mapping_editor.py 포팅(미완).
- **setting**: 색상 프리셋 등.

## 8. 보안
- 포탈 토큰 검증. 본인 작업만. run 실행은 화이트리스트된 config/파라미터만(임의 매크로/명령 금지).
  파일 경로 traversal 방지. 자원 제한.

## 9. 다음 대화에서 시작하는 법
1. 기존 UI 가져오기: `~/Research/lilak/ui/` 를 참고/이식해 `~/web_service/lilak_gui/{backend,frontend}` 구성.
   (lilak-ui 키트는 `~/web_service/lilak_ui` 를 alias.)
2. 포탈 등록은 이미 됨(`data/lilak_gui/service.json`, 지금 placeholder http.server). 백엔드 붙이면:
   - external 로 가면 compose에 `lilak_gui` 컨테이너 추가 + 매니페스트 `mode=external` 로 교체.
   - 로컬은 managed 로 `start.cmd`(UI 백엔드) + `start.env.LILAK_PATH` 로 교체.
3. 포탈 테스트: `http://localhost:8025` 로그인 → lilak_gui 입장(`/p/lilak_gui/`). SSO 토큰 =
   `localStorage.elog_token`/`lilak_portal_token` + Authorization.
4. 규칙: `service_manager/SERVICE_CONTRACT.md` + `AI_SERVICE_GUIDE.md`. 레퍼런스: asset_manager
   (`src-lilak/App.jsx`, 단일 SSO + base-path), elog(서버측 무거운 서비스 + 데이터 디렉터리).
5. 메모리 [[lilak-web-ui]] 에 기존 UI의 상세(포트/JSROOT 함정/파서/탭) 정리되어 있음.

## 10. 마일스톤 (새 빌드)
1. **스켈레톤(완료)** — 폴더 + placeholder + 포탈 등록.
2. **탭 셸(완료)** — `lilak_ui` 키트 기반 elog식 셸 + 보라 테마 + 4 placeholder 탭.
   FastAPI 백엔드(health/whoami/dist 서빙). 포탈 통합(base-path/SSO/`$LILAK_PATH`,
   매니페스트 `uvicorn main:app`) end-to-end 검증.
3. (다음) 탭별 실제 기능 — 실행(run): config 선택→`lilak run_web` 배치+로그;
   파라미터: 편집기; 뷰어: ROOT/JSROOT(Range 서빙); 설정: 테마/언어. 한 탭씩.
4. (다음) 멀티유저: 잡 큐(한 번에 하나, g4toy 패턴) + 사용자 작업공간 + 용량 제한.
5. (다음) external 컨테이너(ROOT+LILAK)로 분리 + compose 통합.

### 새 빌드에 그대로 쓸 검증된 사실 (이식 실험 + 새 셸에서 확인)
- 프론트는 `lilak_ui` 키트를 `LILAK_UI_PATH || ../../lilak_ui` alias 로 소스 소비.
  보라 테마 = `frontend/src/theme/purple.js` 의 토큰 override 프리셋(키트 Teal 과 동일
  메커니즘: `nav-*` + `btn-primary-*` + `text-link` 등을 보라로). `applyTheme()`
  뒤에 `applyPurple()`.
- 모든 API 호출은 `frontend/src/api.js` 한 곳을 지나 `window.__PORTAL_BASE__` 프리픽스
  + `Authorization: Bearer`(localStorage 토큰). 프록시는 private 서비스를 게이팅하므로
  쿠키/헤더 토큰 없으면 `/p/lilak_gui/api/*` 도 막힘(정상).
- 백엔드 SSO 는 **python-jose**(PyJWT 아님), 시크릿 `PORTAL_SECRET_KEY ||
  ELOG_SECRET_KEY || dev-default`. managed 어댑터가 **포탈 venv** 로 `uvicorn main:app`
  실행(포트 자동), `start.env.LILAK_PATH`/`start.cwd` 는 호스트 경로(머신 이동 시 수정).
- LILAK 은 백엔드가 직접 import 안 함 → 무거운 ROOT/LILAK 은 호스트에 있어야 run/뷰어가
  실동작. 빌드: `cd frontend && LILAK_UI_PATH=~/web_service/lilak_ui npm run build`.

### 새 빌드에 그대로 쓸 검증된 포탈 통합 사실 (이식 실험에서 확인)
- managed 어댑터는 **포탈 venv**(`service_manager/.venv`, fastapi+python-jose 보유)로
  백엔드를 실행하고 `start.env` 를 주입. uvicorn 은 `uvicorn main:app` 만 쓰면 포트를
  자동으로 붙여줌(`{port}` 불필요).
- SSO: 스택은 **python-jose**(`from jose import jwt`)를 씀, PyJWT 아님. 공유 시크릿
  precedence = `PORTAL_SECRET_KEY || ELOG_SECRET_KEY || dev-default`. 프록시는
  `accepts_portal_token` 서비스에 한해 JWT 를 백엔드로 전달 — 단 **API 호출은 프론트가
  Authorization 헤더로** 실어 보내야 함(쿠키만으론 백엔드까지 안 감; 쿠키는 프록시 게이팅용).
- base-path: 프록시가 `<base href="/p/lilak_gui/">` + `window.__PORTAL_BASE__="/p/lilak_gui"`
  주입. 프론트 빌드는 `base:'./'` 로 상대경로, 서버-절대 경로(`/api`,`/rootfiles`)는
  프론트에서 `__PORTAL_BASE__` 프리픽스 필요.
- LILAK: 백엔드는 ROOT 를 직접 import 안 하고 `lilak run_web`/`root-config` 를 subprocess
  로 호출 → 무거운 ROOT/LILAK 은 호스트에 있어야 run/jsroot 가 실동작(없으면 §5 external).
  매니페스트 `start.env.LILAK_PATH`/`start.cwd` 는 호스트 경로라 머신 이동 시 수정.
