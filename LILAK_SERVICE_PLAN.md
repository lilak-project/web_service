# LILAK 서비스 — 실행 + ROOT/3D 뷰어 계획 (새 세션 시작용 브리프)

이 문서는 `~/web_service`(LILAK Web Portal 스택)에서 **lilak 프레임워크를 서비스로 완전히
쓰는 것**(파라미터 편집 → 실행 → ROOT 뷰어 → 3D 이벤트 뷰어)을 이어서 구현하기 위한 브리프다.
핵심 원칙: **거의 다 nptoy/nptool이 이미 풀어둔 문제라, 새로 발명하지 말고 그 구조를 이식한다.**

---

## 0. 배경 (이미 되어 있는 것 — origin/main에 반영됨)

- **portal**: `~/web_service/service_manager` (:8025). 서비스는 매니페스트+어댑터로 일반화
  (`managed`=서브프로세스 / `external`=원격). 규칙: `SERVICE_CONTRACT.md`, `AI_SERVICE_GUIDE.md`.
- **스캐폴드**: `scripts/new-service.mjs` — "Create lilak service" 폼(포탈)이 이걸 호출.
  built-in 탭 패턴이 있음: `kind='community'`(채팅), `kind='settings'`, **`kind='parameter'`**.
  built-in은 drop-in으로 패키징됨 — 참고: `scripts/templates/community.py` + `community_api.js`,
  그리고 이번에 만든 파라미터 탭:
  - `scripts/templates/parameter.py` — `build_parameter_router(*, lilak_path, identity)`.
    `lilak par`의 웹 포팅: `$LILAK_PATH` 아래 `.mac/.par/.conf` 브라우즈/열기/저장 (트리 밖 접근 차단).
    순수 파이썬 (ROOT 의존 `/expand`는 제외). 모든 라우트 포탈 인증 게이트.
  - `scripts/templates/parameter_parser.py` — `.mac/.par` 라운드트립 파서 (lilak_gui에서 복사).
  - `scripts/templates/ParameterTab.jsx` — kit-native 에디터 (lilak_gui `ParameterEditor.jsx` 그대로;
    `../api`의 get/post + lilak-ui만 사용).
  - `new-service.mjs`가 `kind='parameter'`면 위 3개 복사 + `build_parameter_router` include +
    `<ParameterTab/>` 렌더.
- **lilak 연결(#2)**: `$LILAK_PATH` env로 프레임워크 경로 지정 (nptool의 `NPTOOL_ROOT`와 동형).
  - 백엔드 폴백: `os.environ.get("LILAK_PATH") or ~/Research/lilak`.
  - **매니페스트에 기본적으로 안 박음** (포터블). `--lilak-path`를 명시할 때만 `start.env.LILAK_PATH`에 박힘.
    → 서버/컨테이너마다 `LILAK_PATH` env 한 번만 세팅하면 됨 (서비스별 매니페스트 수정 불필요).
- **lilak 프레임워크** (dev): `~/Research/lilak`. 실행:
  `bash -c 'source $LILAK_PATH/macros/command_lilak.sh && lilak run_web <config>'` (또는 `lilak <macro>`).
  파라미터 포맷: `ClassName/Prop  value  # comment`, `#` 접두는 비활성. 출력 ROOT는 `data/*.root`, 로그 `data/log/`.

---

## 1. 목표 (이번에 하려는 것)

1. **실행**: 서비스에서 lilak 매크로(시뮬/이벤트) 실행 → `.root` 출력. nptool처럼 **sci-runner 도커에 lilak을 굽고**
   실행을 위임(또는 로컬 실행). 실행 스크립트+데이터는 **공유 볼륨**에 둬서 서비스·sci-runner 양쪽에서 봄.
2. **ROOT 뷰어**: 출력 `.root`를 읽어 히스토그램/트리/브랜치 표시.
3. **3D 이벤트/지오메트리 뷰어**: 예) `~/Research/lilak/atomx/macros_simulation/run_eve.mac` 를 이용한
   이벤트 디스플레이. 나중에 본격 3D 뷰어 이식.

---

## 2. 아키텍처 (nptoy/nptool 이식)

### 2.1 공유 폴더 / 볼륨
- lilak을 **볼륨 하나**에 두고 **서비스 컨테이너 + sci-runner 양쪽에 마운트** (nptool이 sci-runner
  `/opt/nptool` + 데이터 공유하는 방식). `LILAK_PATH`가 그 경로를 가리킴.
- **읽기(프레임워크/매크로 템플릿) vs 쓰기(유저 워크스페이스/출력 .root) 분리** — nptoy 모델:
  - `common/` = 공유 프리셋 (프레임워크에서 1회 추출)
  - `user/<userkey>/inputs|outputs/` = 유저별 편집본 + 실행 산출물
- 편집(파라미터 탭)은 유저 워크스페이스의 매크로를, 실행 출력 `.root`는 그 유저 `outputs/`로.
  ※ 지금 파라미터 탭은 `$LILAK_PATH` 트리를 직접 편집함 — 멀티유저/실행 붙일 때 유저 워크스페이스 모델로 확장 필요.

### 2.2 실행 (runner 추상화) — nptoy 이식
- nptoy `RUNNER` env: `local`(직접 실행) / `sci`(sci-runner에 위임, `SCI_RUNNER_URL`). 이걸 그대로 씀.
- **sci-runner 이미지에 lilak(ROOT+geant4) 굽기** + 공유 볼륨 마운트.
- 서비스의 run 엔드포인트: 매크로를 받아 `local`이면 호스트에서 `source command_lilak.sh && lilak <macro>`,
  `sci`면 sci-runner로 POST → `.root`를 공유 outputs에 씀.
- **이식 대상**: `nptoy/backend/`의 `sim_client.py`, `session.py`, `worker.py`, `config.py`(RUNNER/SCI_RUNNER_URL).

### 2.3 ROOT 뷰어
- **TEve/ROOT GUI를 컨테이너에서 띄워 스트리밍하지 말 것** (X서버/VNC 필요, 무겁고 취약).
- **히스토그램/트리/브랜치 → JSROOT(브라우저 내)**: `.root`를 **HTTP-Range 지원으로 서빙**
  (lilak-web-ui/ lilak_gui가 이미 하던 방식) → JSROOT가 브라우저에서 직접 읽음. 서버측 ROOT 실행 불필요.

### 2.4 3D 이벤트/지오메트리 뷰어 — "실행 → 씬 export(JSON) → three.js"
- **nptoy가 이미 하는 것**: GeometryTab "Geant4 검증"이 서버에서 construction을 돌려 정확한 씬
  (mesh triangles)을 JSON export → `frontend/src/g4/Viewer.jsx`(three.js)가 렌더. 트랙/hit도 동일.
- **run_eve.mac을 "네이티브 디스플레이 열기"가 아니라 "이벤트 씬을 JSON으로 export"로 바꾸거나 run_web 변형**을
  만들고, 프론트는 **nptoy `Viewer.jsx` + 씬 스키마를 이식**해서 three.js로 렌더.
- 즉 3D 뷰어는 **새로 만드는 게 아니라 nptoy Viewer를 lilak 씬 export에 맞춰 이식**하는 작업.

---

## 3. 단계 (독립적, 1→4 순서로 하나씩)

1. **공유 볼륨 + LILAK_PATH** — 서비스·sci-runner가 lilak 파일 공유. (파라미터 탭은 이 단계에서 이미 동작)
2. **run 엔드포인트 + runner(local/sci)** — nptoy `sim_client`/`session`/`worker` 이식, 매크로 실행 → `.root` 출력.
3. **ROOT 뷰어** — `.root` Range 서빙 + JSROOT (플롯/트리). built-in 탭으로.
4. **3D 뷰어** — sci-runner에서 이벤트 씬 JSON export(run_eve.mac 변형) + nptoy `Viewer.jsx` 이식(three.js). built-in 탭으로.

각 단계를 **built-in 탭**(community/parameter처럼 drop-in `kind='run'/'viewer'/'eventview'`)으로 패키징하면
create-lilak-service에서 토글해서 재사용 가능.

---

## 4. 이식 지도 (참고 파일)

| 필요한 것 | 참고 (nptoy/lilak) |
|---|---|
| 실행/runner (local/sci) | `nptoy/backend/{sim_client,session,worker,config}.py`, `SCI_RUNNER_URL` |
| 3D 뷰어 (three.js) | `nptoy/frontend/src/g4/Viewer.jsx` + `GeometryTab.jsx`(씬 export "Geant4 검증") |
| ROOT Range 서빙 + JSROOT | `lilak_gui` 백엔드 / lilak-web-ui (memory `lilak-web-ui`) |
| built-in 탭 패키징 패턴 | `scripts/templates/community.py`+`community_api.js`, `parameter.py`+`ParameterTab.jsx`, `new-service.mjs`의 `kind` 분기 |
| lilak 실행/파라미터 인터페이스 | `~/Research/lilak/macros/command_lilak.sh`, `meta/parameters/`, memory `lilak-web-ui` |

## 5. 핵심 사실 / 주의

- 매니페스트 env 우선순위: `os.environ` → 포탈 주입 → **`start.env`(마지막, 이김)** (`service_manager/app/adapters/managed.py`).
  → `LILAK_PATH`는 서버/컨테이너 env로 두는 게 포터블 (이미 그렇게 바꿈).
- 편집(파라미터 탭)+실행 둘 다면 **lilak 볼륨 하나를 서비스와 sci-runner 양쪽에 마운트** — 탭이 편집, sci-runner가 실행.
- `run_eve.mac`: `~/Research/lilak/atomx/macros_simulation/run_eve.mac` (이벤트 디스플레이). 웹에선 **씬 JSON export**로 변형.
- 스캐폴드/포탈은 lilak_ui kit을 소스-alias로 공유 — kit 변경 시 fleet 게이트(`service_manager/verify-fleet.sh`)로 검증.

## 6. 새 세션에 넘길 때

이 파일을 열고 시작하면 됨: `~/web_service/LILAK_SERVICE_PLAN.md`.
추천 시작점: **3단계 중 (2) 공유 볼륨 + 실행 배선**부터 (nptoy `sim_client`/`session` 이식). 그 다음 ROOT 뷰어 → 3D 뷰어.
