# g4toy — 개발 주문서 (Geant4 Toy — light nuclear-physics simulation)

> 이 문서 하나만 보고 새 대화에서 개발을 이어갈 수 있도록 쓴 명세서입니다.
> 포탈(`service_manager`) 통합을 전제로 합니다. 지금은 **폴더 + placeholder +
> 포탈 등록**까지만 되어 있고, 실제 구현은 아직 안 했습니다.

## 0. 한 줄 요약
포탈 로그인 사용자가 웹에서 Geant4(+ROOT+nptool) 시뮬레이션의 **파라미터를 조정**하고,
**잡 큐**(한 번에 하나씩, 순서대로, 너무 길면 끊김)로 서버에서 실행하고, **이벤트
뷰어를 임베드**해 결과를 보고 **데이터를 다운로드**하는 서비스. 아이디별 작업 폴더 +
용량 제한.

## 1. 이름 / 서비스 ID
- 서비스 id (폴더·URL): **`g4toy`**
- 포탈 매니페스트: `data/g4toy/service.json` (이미 등록됨 — 지금은 placeholder 정적 서빙)
- 진입 경로: `/p/g4toy/` (단일 서비스 프록시)
- 코드 위치: `~/web_service/g4toy/` (`public/` placeholder, 앞으로 `backend/` `frontend/`)

## 2. 포탈 통합 계약 (반드시 지킬 것)
포탈의 `SERVICE_CONTRACT.md` / `AI_SERVICE_GUIDE.md` 규칙을 따른다.

- **단일 서비스** (`capabilities.multi_project = false`). "프로젝트"는 포탈이 아니라
  서비스 내부의 **사용자별 폴더**로 관리한다(포탈 프로젝트 X). 진입은 `/p/g4toy/`.
- **SSO** (`identity.accepts_portal_token = true`). 진입 시 포탈이 사용자의 JWT를
  `Authorization: Bearer` 헤더(그리고 최상위 네비게이션용 `lilak_portal_token` 쿠키)로
  넘긴다. 백엔드는 **공유 시크릿(`ELOG_SECRET_KEY`)** 으로 HS256 검증하고, 토큰의
  `email`/`username` 으로 사용자를 식별한다. (포탈·elog와 같은 시크릿 → 토큰 호환.)
- **가시성**: private(1) 권장 — 무거운 컴퓨팅 자원이라 권한 받은 계정만. 포탈 권한
  게이트가 입장 자체를 막는다(서비스 권한 없는 계정은 못 들어옴). 그룹 권한/초대코드로
  접근 부여 가능(포탈 Account/Services 화면).
- **base-path 인식**: 프록시 뒤(`/p/g4toy/`)에서 동작하도록 — Vite `base:'./'`,
  `index.html`에 `<base href="/">`(포탈이 `/p/g4toy/`로 덮어씀), 모든 API/asset 경로는
  `window.__PORTAL_BASE__` 기준 상대경로. (elog/asset_manager와 동일 패턴.)
- **health**: `GET /` 또는 `GET /api/health` 200.

## 3. 실행 환경 — **확정: Docker / external 서비스**
Geant4(+데이터) + ROOT 는 런타임 ≈ **3GB**(Geant4 libs 187M + 데이터 2.1G + ROOT 736M;
nptool 는 옵션 ~510M)라 **포탈 이미지에 넣지 않는다.** g4toy은 **자체 이미지 + external
서비스**(별도 컨테이너). 결정 근거: macOS arm64 네이티브 바이너리는 리눅스 컨테이너에서
못 돌므로 어차피 리눅스 빌드가 필요 → 그럴 바엔 컨테이너로 격리·이식성 확보.

### 3.1 배포 모델 — **이미지가 산출물, 원격 서버에서 서비스**
로컬의 Geant4/ROOT/nptool 설치는 **개발·참고용일 뿐 이미지에 들어가지 않는다.**
최종 산출물 = **g4toy Docker 이미지**를 빌드 → **레지스트리에 push** → **다른(원격)
서버에서 pull 해서 compose 로 서비스**. 따라서:
- **플랫폼**: 원격 서버가 amd64면 `docker buildx --platform linux/amd64` 로 빌드
  (이 맥은 arm64라 그냥 빌드하면 arm64 이미지가 됨). 타겟 아키텍처를 먼저 못박을 것.
- 이미지 안에서 toolchain + 데이터가 self-contained (호스트 마운트 의존 X). 영속 데이터
  (유저 폴더 + sqlite)만 볼륨으로 분리.

### 3.2 toolchain — **버전 고정: ROOT 6.38.00 + Geant4 11.4.0 (도커 안에서 빌드)**
로컬과 동일 버전을 **이미지 안에서 직접 설치**한다(로컬 설치 재사용 X).
- **ROOT 6.38.00**: 공식 발행 이미지 `rootproject/root:6.38.00` 베이스로 확보(정확한
  태그는 `docker pull` 로 확인 — `6.38.00` 또는 `6.38.00-ubuntuXX.YY`).
- **Geant4 11.4.0**: 소스 빌드(데이터 + GDML 포함). nptool `np_docker_base` 레시피
  구조를 따르되 버전만 11.4.0 으로.
- **첫 예제 = `cssu_geant4_simulation`** (github `ejungwoo/cssu_geant4_simulation`):
  **Geant4 단독** 앱(`useROOT false`, ROOT 링크 안 함). 이미지에서 git clone + cmake
  빌드 → 실행파일 `g4run`. (§4.1·§4.4 가 이 예제 구조로 확정됨.)
- **nptool = 옵션** (이 예제엔 불필요). 다른 예제를 붙일 때만 빌드 레이어 추가.

```dockerfile
# g4toy/Dockerfile (멀티스테이지 개요)
FROM rootproject/root:6.38.00 AS toolchain        # ROOT 6.38.00
RUN apt-get update && apt-get install -y \
    cmake ninja-build wget git python3 python3-pip \
    libexpat1-dev libxerces-c-dev libtbb-dev libsm-dev \
    libxft2-dev libxpm-dev libxext-dev libtiff-dev libgif-dev && apt-get clean
# --- Geant4 11.4.0 (source build: data ON, GDML ON, on-screen vis OFF) ---
WORKDIR /opt
RUN wget https://gitlab.cern.ch/geant4/geant4/-/archive/v11.4.0/geant4-v11.4.0.tar.gz && \
    mkdir geant4 geant4_build geant4_install && \
    tar -xf geant4-v11.4.0.tar.gz -C geant4 --strip-components 1 && rm geant4-v11.4.0.tar.gz && \
    cd geant4_build && cmake -GNinja -DCMAKE_INSTALL_PREFIX=/opt/geant4_install \
      -DGEANT4_INSTALL_DATA=ON -DGEANT4_USE_GDML=ON /opt/geant4 && \
    ninja install && cd /opt && rm -rf geant4_build geant4
# --- nptool (OUR fork) + projects: the simulation engine ---
ENV NPTOOL=/opt/nptool
COPY nptool/ /opt/nptool/        # 또는 RUN git clone <our-nptool-fork> /opt/nptool
RUN bash -lc "source /opt/root/bin/thisroot.sh && \
    source /opt/geant4_install/bin/geant4.sh && \
    cd /opt/nptool/NPLib && cmake -GNinja . && ninja install && \
    cd /opt/nptool/NPSimulation && cmake -GNinja . && ninja install"
# Projects in config.PROJECTS (e.g. Projects/jungwoo/simulation_12C) must be present.
# --- g4toy backend ---
COPY backend/ /app/backend/
RUN pip3 install --no-cache-dir -r /app/backend/requirements.txt
EXPOSE 8050
# worker runs: g4run <generated.mac>  (ROOT only needed for conversion.C analysis)
CMD ["bash","-lc","source /opt/root/bin/thisroot.sh && \
     source /opt/geant4_install/bin/geant4.sh && \
     cd /app/backend && uvicorn main:app --host 0.0.0.0 --port 8050"]
```
> 빌드 시 `GEANT4_INSTALL_DATA=ON` 이 데이터 2.1G 를 받으므로 이미지가 큼/빌드 김 →
> §3.4 다이어트로 줄일 수 있음.

### 3.3 배치
- g4toy 백엔드가 컨테이너 안에서 포트 `8050`.
- 원격 서버의 `docker-compose.yml` 에 `g4toy` 서비스(포탈과 같은 네트워크) + **영속
  볼륨**(유저 폴더 + sqlite).
- 포탈에 **`mode=external`, `url=http://g4toy:8050`, `accepts_portal_token=true`** 등록.
  (개발 중에는 managed+로컬 백엔드, 이미지/원격 붙이면 external 로 교체.)

### 3.4 데이터 다이어트(옵션)
데이터 2.1G 중 `G4NDL`(중성자 HP, 1.1G)·`RealSurface`(127M)는 해당 물리 안 쓰면 제거 →
이미지 대폭 축소. 다이어트 여부는 §3.5에서 정할 물리/검출기 셋업에 달림.

### 3.5 결정 현황 (마일스톤 4 진입 전)
- ✅ **ROOT 6.38.00 + Geant4 11.4.0**, 도커 안에서 빌드 (§3.2).
- ✅ **첫 예제 = `cssu_geant4_simulation`** (Geant4 단독). nptool 옵션으로 보류.
- ⬜ **cssu 파라미터를 매크로 구동식으로** — 현재 g4run.cc 에 하드코딩(pressure/입자/
  에너지/방향/stepLimit) → 웹 조절하려면 G4messenger(또는 argv/env)로 받게 작은 C++
  수정 필요(cssu 레포). 출력 파일경로도 인자/env 로. ⚠️ **이게 마일스톤 4의 핵심 선결.**
- ⬜ **타겟 서버 아키텍처**(amd64?)와 **레지스트리**(어디로 push).

## 4. 기능 명세
### 4.1 입력 편집 (nptool 기준 — cssu 제거됨)
**엔진은 nptool 단독.** 일반화된 실행: `npsimulation -D detector -E reaction -O output.root -N`.

**편집 워크스페이스 (phase 0 — 완료, `backend/inputs.py`)**: 유저별 `inputs/` 에 nptool
입력파일(detector/reaction/cross-section/project.config)을 두고 **예제(`config.PROJECTS`:
ATOMX_12C / ATOMX_34Ar)에서 시드 → 웹에서 편집 → 저장**. `manifest.json` 이 어떤 파일이
detector/reaction/output 인지 기록(파일명 일반화). 세션/잡이 이 워크스페이스를 복사해 실행.
- API: `GET /api/inputs`(manifest+files+examples), `GET/PUT /api/inputs/file`,
  `POST /api/inputs/load-example`. 프론트 `Inputs.jsx` 카드(예제 로드 + 파일목록 +
  텍스트 에디터 + save). 검증: 34Ar 로드 → 세션이 34Ar 빔으로 실행됨(`Particle: 34Ar`).
- 배치 잡 파라미터(`params.py`) = `n_events` 뿐 → `/run/beamOn N`.

**다음 (phase 1·2 — 구조 폼)**: 포맷은 `블록토큰` + 들여쓴 `Key = Value [단위]`.
- detector: **ATOMX**(가스 TPC params: TPC_*, Gas_Material/Fraction/Pressure/…) /
  **STARK**(Type **X6/BB10/QQQ5**, POS, RotateXYZ, CsI). 확장 가능하게 **레지스트리**로.
- reaction: **Beam**(필수) → **TwoBodyReaction**(Beam/Target/Light/Heavy/Excitation/
  CrossSectionPath/Shoot) → **Decay**(선택) → cross-section(flat 기본 + 지수감쇠; 각도/값 2열).
- raw 텍스트 편집은 지금도 됨 → 폼은 그 위에 얹는다.

### 4.2 잡 실행 + 큐 (핵심)
- **전역 단일 워커**: 동시에 **1개 잡만** 실행. 나머지는 **FIFO 대기**. 여러 아이디가
  동시에 던져도 순서대로 하나씩.
- 흐름: 제출 → `queued`(큐 등록) → 워커가 하나씩 꺼냄 `running` → `done|failed`.
- **타임아웃**: 잡 최대 실행시간(기본 예 10분, 설정가능) 초과 시 프로세스 kill →
  `timeout`. 너무 길어지면 자동으로 끊긴다.
- **취소**: 본인 잡 취소(`cancelled`). 큐 위치 표시.
- 잡 단위로 사용자 폴더에 작업 디렉터리(입력 .mac + 출력 .root/data + 로그).

### 4.3 사용자별 작업공간 + 용량 제한
- `data/g4toy/users/<user_key>/jobs/<job_id>/` (user_key = 포탈 email 또는 안전한 해시).
- **디스크 쿼터**: 사용자당 최대 용량(예 1GB). 초과 시 새 잡 거부 + 정리 안내.
  (제출 전 쿼터 체크, 잡 결과 size 기록.)

### 4.4 이벤트 뷰어 임베드 (확정 방향: three.js + 값 기반 렌더)
스트리밍이 아니라 **데이터 export → 브라우저 렌더**. 이 Geant4 빌드는 OpenGL-X11/VTK
미빌드라 어차피 온스크린 GL 경로는 없음(`gdml[yes]`, `qt[yes]`).

**렌더 스택**: **react-three-fiber**(three.js의 React 래퍼) + **drei**(OrbitControls/
Line/Points). 프론트가 React+lilak_ui라 자연스럽고, 마우스로 돌려보기·트랙 선·포인트
클라우드가 거의 공짜.

**핵심 단순화 — 좌표 "값"으로 그린다(지오메트리는 1차에 우회)**:
- **트랙**: per-event 좌표 폴리라인 배열 → `<Line>`(pdg/charge별 색).
- **에너지 손실 포인트**: `[x,y,z,edep]` 배열 → `<Points>`(edep로 색/크기).
- **지오메트리(물리볼륨 와이어)**: **GDML 자동 변환 구현됨**(`backend/gdml.py`).
  Geant4 `G4GDMLParser` 스타일 `.gdml` → Scene JSON geometry(box/tube→cylinder/
  orb→sphere, 배치 position+rotation, 볼륨 계층을 월드 절대좌표로 합성). three.js가
  와이어프레임으로 그림. 잡 디렉터리에 `geometry.gdml` 이 있으면 자동 파싱(없으면 빈
  지오메트리). **여러/복잡 지오메트리도 GDML만 주면 자동.** `<assembly>` 지원 → ATOMX 199
  솔리드 확인. nptool 은 `/det/export_gdml` 로 GDML 생성(아래 producer 노트).

**Scene JSON 계약 (뷰어용 export 포맷)**:
```jsonc
{
  "geometry": [ { "type":"box", "name":"target", "size":[40,40,0.5], "pos":[0,0,0] }, … ],
  "tracks":   [ { "pdg":2212, "charge":1, "points":[[x,y,z], …] }, … ],
  "edep":     [ [x,y,z,energy], … ]
}
```
`GET /api/jobs/{id}/viewer` 가 이 JSON을 반환. **구현됨**(`backend/scene.py`): cssu txt
파싱 → geometry(World/Detector 박스) + tracks(eventID 묶음) + edep. 무인증 데모는
`GET /api/demo/scene`. 실제 geometry 도형은 cssu DetectorConstruction 값 반영.

**남은 일**: 실제 `g4run` 이 잡마다 `geometry.gdml` 을 export 하도록(매크로
`/persistency/gdml/write` 또는 C++ `G4GDMLParser::Write`) — 그러면 그 잡의 실제
지오메트리가 그대로 뷰어에 뜸. 트랙/에너지 필드 확장(시간, 2차 입자, pdg 색)도 동일 계약
안에서. (지원 솔리드: box/tube/orb. 나머지는 `skipped` 로 표시되고 무시.)

> **nptool 라이브 뷰어 — 완료(2026-06-30), 브라우저 검증됨.** 세션/잡이 nptool 실제
> 출력으로 3D를 채움: 세션 start→idle 시 백엔드가 `/det/export_gdml geometry.gdml` 자동
> 전송 → `gdml.py` 파싱(ATOMX 199 솔리드) → 지오메트리 표시; Run(`/run/beamOn`) 마다
> `online_stream.dat` 갱신 → `scene.from_online` 파싱 → 트랙/포인트 라이브(프론트가
> `/api/session/scene` 1.2초 폴링). 잡도 동일(배치 macro에 export_gdml + `--online-...`).
> - **지오메트리(GDML)**: nptool 에 **이미 `/det/export_gdml <file>` 명령 존재**(C++ 수정
>   불필요!). 배치는 매크로 첫 줄에, 세션은 Idle 후 백엔드가 전송 → `geometry.gdml` 생성.
>   `gdml.py` 에 `<assembly>` 지원 추가 → ATOMX 실제 지오메트리 **199 솔리드** 파싱 확인
>   (boolean subtraction 2개만 skip). `Write()` 가 즉시 open→write→close 라 세션 살아있어도 읽힘.
> - **온라인 트랙/포인트 (live)**: nptool 에 **`--online-data-streaming <N>` 옵션 신규 추가**
>   (`NPOptionManager` + `SteppingAction`, 빌드·검증 완료). 각 `/run/beamOn` 마다 **처음 N
>   이벤트**의 매 스텝을 `online_stream.dat`(cwd) 에 flush 텍스트로 기록(파일은 run마다
>   truncate → 항상 최신 beamOn). 컬럼: `evt trk parent pdg charge x y z edep`. append-only
>   flush 라 ROOT close 없이도 백엔드가 **tail 로 라이브** 읽기 가능(§ ROOT open 문제 회피).
>   → 백엔드가 tail·파싱: 트랙 = `(evt,trk)` 묶음 폴리라인, 포인트 = edep>0, charge/pdg 색.
> - **최종/분석**: ROOT(`--record-track`) 은 그대로 (다운로드·npanalysis). 끝난 뒤 읽기.
> ⚠️ 이 nptool 수정은 `~/Research/nptool_cens` 소스(`NPOptionManager`, `SteppingAction`)에
> 들어갔으니 **Docker 이미지에 그 포크가 들어가야** 적용됨(마일4).

### 4.5 데이터 다운로드
- 잡 결과(.root, 로그, 매크로)를 zip 다운로드. 포탈 토큰 인증된 **본인 잡만**.
  (다운로드는 최상위 네비게이션이 아니라 fetch+blob — 포탈 토큰 헤더 필요.)

### 4.6 인터랙티브 세션 (nptool) — **구현·검증됨**
배치 잡(§4.2)과 **별개 모델**. `npsimulation … -N` 이 stdin 에서 UI 명령을 읽는 G4
터미널(`Idle>`)을 띄움 → 장수명 프로세스로 유지하고 웹 **Run 버튼**이 `/run/beamOn <n>`
을 하나씩 밀어넣음. 각 beamOn 이 같은 열린 ROOT 트리에 **누적**(검증: 3+5+2 → 트리 10
entries). `backend/session.py` (`Session` + `SessionManager`).
- **유저당 1 세션**, 전역 상한(`MAX_SESSIONS`). 세션마다 유저 워크스페이스에 프로젝트
  격리 사본(`users/<key>/sessions/<id>/`)을 두고 거기서 실행 → 출력 충돌 방지.
- **보안(핵심)**: G4 터미널 stdin 은 `/control/shell` 같은 **셸 탈출**도 받음 → 사용자
  텍스트 절대 전달 금지. 백엔드가 검증된 정수로 `/run/beamOn <n>` 문자열만 구성해 write.
  프로젝트는 화이트리스트(`config.SESSION_PROJECTS`).
- 프론트: 헤더 `▶ session` → 우측 패널(프로젝트 선택, start/stop, beamOn 입력+run,
  상태 배지, 라이브 stdout 로그 폴링). 첫 예제 = `ATOMX_12C`(jungwoo nptool 프로젝트).
- 남은 것: stop 후 누적 `.root`(`--record-track`) 를 파싱해 §4.4 뷰어로(트랙/포인트);
  Docker 이미지에 nptool + 프로젝트 포함(마일4).

## 5. API 설계
```
GET  /api/health
GET  /api/me                  포탈 토큰 → 사용자 + 쿼터 사용량
GET  /api/params/schema       조작 가능한 파라미터 정의(폼 자동생성용)
POST /api/jobs                {params} → 잡 제출(큐 등록), 쿼터/검증
GET  /api/jobs                내 잡 목록 + 상태 + 큐 위치
GET  /api/jobs/{id}           상태 + 로그 tail
POST /api/jobs/{id}/cancel    본인 잡 취소
GET  /api/jobs/{id}/result    결과 zip
GET  /api/jobs/{id}/viewer    뷰어용 Scene JSON (geometry+tracks+edep)
GET  /api/demo/scene          무인증 데모 Scene JSON
GET  /api/queue               전역 큐 상태(running 1 + queued N)
-- 인터랙티브 세션 (§4.6) --
GET  /api/session/projects    실행 가능한 프로젝트(화이트리스트)
GET  /api/session             내 세션 상태(state/runs/...)
POST /api/session/start       {project} → npsimulation -N 세션 시작
POST /api/session/run         {n} → /run/beamOn n 밀어넣기(검증)
GET  /api/session/log?since=  새 stdout 라인(폴링)
POST /api/session/stop        exit → 종료 + ROOT flush
```

## 6. 데이터 모델 (서비스 자체 DB, 포탈과 분리)
- `Job`: id, user_key, status(queued|running|done|failed|timeout|cancelled),
  params_json, created_at, started_at, finished_at, workdir, exit_code, size_bytes,
  error.
- 큐 = DB의 status 기반 + 단일 워커 루프(별도 큐 브로커 불필요, SQLite로 충분).

## 7. 잡 큐 / 워커 구현 가이드
- **워커 1개**(백그라운드 thread / asyncio task / 별도 프로세스): 가장 오래된 `queued`
  잡 1개 → `running` → `subprocess.run([geant4 ...], timeout=MAX)` → 결과 수집 → `done`.
- 동시성: 워커는 반드시 1개(락/단일 루프로 보장). 잡 자체도 별도 프로세스 + 자원 제한
  (`nice`, `ulimit`, 가능하면 cgroups), 작업 디렉터리 격리.
- 타임아웃: subprocess timeout → 프로세스 트리 kill → `timeout`.
- 재시작 복원: 부팅 시 `running`으로 남은 잡은 `failed`로 정리(워커가 죽었던 것).

## 8. 보안
- 포탈 토큰 검증(공유 시크릿). **본인 잡만** 접근. 파라미터 화이트리스트(임의 코드/매크로
  금지). 실행 샌드박스 + 자원 제한. 다운로드/작업경로 path-traversal 방지.

## 9. 프런트엔드
- `lilak_ui` 키트 사용(포탈/elog와 톤 일치), base-path aware. 화면 흐름:
  파라미터 폼 → 제출 → 내 잡/큐 현황 → 결과 뷰어(three.js / react-three-fiber, §4.4)
  + 다운로드 + 쿼터 표시.

## 10. 다음 대화에서 개발 시작하는 법
1. 코드: `~/web_service/g4toy/` 에 `backend/`(FastAPI) + `frontend/`(Vite+lilak_ui) 추가.
2. 포탈 등록은 이미 됨(`data/g4toy/service.json`, 지금은 placeholder `http.server`).
   백엔드 붙이면:
   - external 구조로 가면 → `docker-compose.yml`에 `g4toy` 컨테이너 추가 +
     매니페스트를 `mode=external, url=http://g4toy:8050` 로 교체(또는 핸드셰이크 등록).
   - 빠른 로컬 개발은 managed로 `start.cmd`를 백엔드 실행(`uvicorn main:app` 등)으로 교체.
3. 포탈로 테스트: `http://localhost:8025` 로그인 → g4toy 입장(`/p/g4toy/`). SSO 토큰은
   `localStorage.elog_token`/`lilak_portal_token` + `Authorization` 헤더.
4. 포탈 통합 규칙은 `service_manager/SERVICE_CONTRACT.md` + `AI_SERVICE_GUIDE.md` 참고.
   asset_manager(`src-lilak/App.jsx`)가 단일 서비스 + SSO + base-path의 좋은 레퍼런스.

## 11. 마일스톤
1. **스켈레톤(완료)** — 폴더 + placeholder + 포탈 등록.
2. **백엔드 뼈대(완료)** — FastAPI, 포탈 토큰 검증(`jose`, 공유 시크릿), `/api/me`,
   사용자별 작업폴더 + 디스크 쿼터. (`backend/`)
3. **잡 큐 + 단일 워커(완료)** — SQLite `Job` = 큐, 단일 워커 스레드(FIFO, 동시 1개),
   타임아웃(프로세스그룹 kill)/취소. 매니페스트 `start` → `uvicorn main:app`.
4. **실제 nptool 연결(로컬 완료, Docker 남음)** — cssu 스탠드인 **제거**, 엔진 = nptool.
   배치 잡 = `npsimulation -B`(워커), 인터랙티브 = `npsimulation -N`(세션). 로컬 toolchain
   으로 검증 완료. **남은 것 = Docker 이미지(§3.2: ROOT 6.38+Geant4 11.4+nptool 포크+
   프로젝트+백엔드) + compose + 매니페스트 external 교체**(원격 배포).
5. **이벤트 뷰어(렌더러 완료, nptool 연결 남음)**: `frontend/` (react-three-fiber/drei)가
   §4.4 Scene JSON 을 3D 렌더 — 와이어프레임 볼륨 + 트랙 + 에너지 포인트, per-volume 토글/
   solo, reset-view, gizmo. **GDML→지오메트리 자동(`gdml.py`)도 완료.** 남은 것:
   **nptool ROOT→tracks/points 추출**(§4.4 producer 노트) + **nptool GDML export**(C++ 추가)
   → 그래야 실제 nptool 이벤트가 뷰어에 뜸. + 잡 목록/제출 UI, 결과 zip 버튼.
6. 인터랙티브 세션(완료, §4.6) / 쿼터·정리 / lilak_ui 톤 통합.

> 진행 메모(2026-06-30): 엔진 nptool 단독으로 통일(cssu 제거). API §5 전부 구현 + 세션
> API(§4.6). 남은 1차 = (a) nptool ROOT→뷰어 추출 + nptool GDML, (b) Docker 이미지/원격.
