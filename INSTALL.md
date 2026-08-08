# LILAK Web Portal — 다른 서버에 설치하기

한 개의 Docker 이미지로 포탈 + 모든 서비스가 돌아갑니다. **코드는 git**, **데이터는
서버의 호스트 폴더**(`/app/data`에 바인드마운트)에만 있습니다. 따라서 재빌드/업데이트는
데이터를 건드리지 않고, 각 서버는 자기 데이터를 독립적으로 보관·백업합니다.

구조: 슈퍼레포 `lilak-project/web_service`
- 직접 추적: `service_manager`(포탈) + docker 파일
- 서브모듈 6개: `lilak_elog`, `lilak_ui`, `asset_manager`, `scattering_simulation_2d`,
  `g4toy`, `lilak_gui` (각자 GitHub repo)

---

## 0. 사전 준비 (서버에 필요한 것)

- **git**, **Docker Engine**, **Docker Compose 플러그인**
  ```sh
  # Ubuntu/Debian 예시
  sudo apt-get update
  sudo apt-get install -y git ca-certificates curl
  # Docker (공식 편의 스크립트)
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"        # 로그아웃/로그인 후 sudo 없이 docker 사용
  docker version && docker compose version
  ```
- **GitHub SSH 접근권**: 서브모듈 URL이 모두 `git@github.com:...` (SSH)이고 일부는
  **private**(`web_service`, `g4toy`, `lilak_gui`, `cens-assets-tracker`)입니다.
  서버에서 이 repo들을 clone하려면 SSH 키가 GitHub에 등록돼 있어야 합니다.

  ```sh
  # 서버에서 키 생성 (이미 있으면 건너뜀)
  ssh-keygen -t ed25519 -C "lilak-server" -f ~/.ssh/id_ed25519 -N ""
  cat ~/.ssh/id_ed25519.pub
  ```
  출력된 공개키를 **GitHub 계정 → Settings → SSH keys**에 추가하거나(가장 간단),
  각 repo의 **Deploy key**로 추가하세요. 확인:
  ```sh
  ssh -T git@github.com          # "Hi <user>! You've successfully authenticated" 뜨면 OK
  ```

  > HTTPS만 쓰고 싶으면 clone 후 `.gitmodules`의 `git@github.com:` 를
  > `https://github.com/` 로 바꾸고 `git submodule sync` 하면 됩니다(개인 액세스 토큰 필요).

---

## 1. 최초 설치 (서버에서 1회)

> 서비스를 전부 미리 받지 않고 **포털만 설치한 뒤 나중에 골라서 설치**할 수도 있습니다
> (`--recursive` 생략 → 홈의 **서비스 매니저** 카드에서 설치).
> 자세한 내용: `service_manager/DEPLOYMENT.md` §8

```sh
# 1) 코드 받기 (--recursive 로 서브모듈까지 한 번에)
sudo mkdir -p /opt/web_service && sudo chown "$USER" /opt/web_service
git clone --recursive git@github.com:lilak-project/web_service.git /opt/web_service
cd /opt/web_service

# 2) 환경파일 준비
cp .env.example .env

# 3) 시크릿 생성 (두 개)
python3 -c "import secrets; print('ELOG_SECRET_KEY='+secrets.token_urlsafe(48))"
python3 -c "import secrets; print('PORTAL_REGISTER_TOKEN='+secrets.token_urlsafe(32))"
```

생성된 값으로 **`.env`** 를 편집합니다:

```ini
# 필수 시크릿 (위에서 생성한 값 붙여넣기)
ELOG_SECRET_KEY=<붙여넣기 — 포탈과 elog가 공유 → SSO>
PORTAL_REGISTER_TOKEN=<붙여넣기>

# 이메일 인증: 실제 메일 발송기는 아직 없음.
#  - 내부/폐쇄망이면 인증 끄기 권장:  EMAIL_VERIFY_REQUIRED=0
#  - 켜둘 거면 DEV_ECHO=1 로 두면 인증 링크가 API 응답에 노출됨
EMAIL_VERIFY_REQUIRED=1
EMAIL_VERIFY_DEV_ECHO=1

# 데이터 폴더 (컨테이너 밖, 이 서버 전용). 큰 디스크 경로 권장.
PORTAL_DATA_DIR=/srv/lilak/data

# 네트워킹
PORTAL_PORT=8025
PORTAL_BASE_URL=https://portal.example.org      # 실제 공개 URL (없으면 http://<서버IP>:8025)
```

```sh
# 4) 데이터 폴더 만들기 (PORTAL_DATA_DIR 로 지정한 경로)
sudo mkdir -p /srv/lilak/data && sudo chown "$USER" /srv/lilak/data

# 5) 빌드 + 기동 (첫 부팅에서 서비스 자동 시드, DB 자동 생성/마이그레이션)
docker compose up -d --build

# 6) 확인
docker compose ps
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8025/     # 200 이면 정상
docker compose logs -f portal                                       # 로그 보기 (Ctrl-C 로 나감)
```

브라우저로 `http://<서버IP>:8025` (또는 `PORTAL_BASE_URL`) 접속 →
**맨 처음 가입하는 계정이 자동으로 관리자(admin)** 가 되고, 가입 도메인/초대코드 제한도
면제됩니다. 이후 계정은 관리자가 Account 탭에서 관리합니다.

> 위 `docker compose up` 은 **가벼운 포탈 이미지만** 빌드합니다(elog/asset/scattering/
> nptoy/g4toy/lilak_gui 는 managed 서비스로 포함). ROOT+Geant4+nptool 이 필요한
> 무거운 `sci-runner` 는 아래처럼 **따로(opt-in)** 빌드합니다.

## sci-runner (nptoy 시뮬 백엔드 — ROOT + Geant4 + nptool)

nptoy 웹은 포탈 안 managed 서비스로 돌고, 실제 시뮬 계산은 별도 `sci-runner` 컨테이너가
합니다. 무겁고(이미지 ~수 GB) **Geant4 + nptool 컴파일에 ~1시간** 걸리므로 opt-in 입니다.

```sh
# x86_64 리눅스 서버에서 (네이티브 → 정상 컴파일). 여유 디스크 ~20GB 권장.
# nptool_cens(dev)는 public 이라 빌드 중 자동 clone (SSH 키 불필요, 인터넷만 필요).
docker compose --profile sci up -d --build     # 처음 한 번은 ~1시간

# 확인
docker compose ps                              # portal + sci-runner 둘 다 Up
docker compose exec sci-runner curl -s localhost:8100/health   # {"ok":true,...}
```

- 포탈과 sci-runner 는 내부 네트워크로 연결(`http://sci-runner:8100`), 결과는 공유
  볼륨(`sci-data`)에 저장돼 nptoy 가 읽습니다. sci-runner 포트는 **외부에 공개되지 않음**.
- ROOT 6.38 / Geant4 11.4 로 고정(`sci-runner/Dockerfile` 의 build arg 에서 변경 가능).
- **arm 맥에서는 빌드 불가**(ROOT 베이스가 amd64 전용 → 에뮬레이션 시 컴파일러 segfault).
  반드시 x86_64 호스트에서 빌드하세요.

---

## 2. 업데이트 (코드 새 버전 반영)

데이터(`PORTAL_DATA_DIR`)는 절대 안 건드립니다. 새 DB 컬럼은 부팅 시 자동 마이그레이션.

**방법 A — 개발 맥에서 원격 배포 (추천):**
```sh
# 맥의 ~/web_service 에서
./deploy.sh user@server                    # 원격 경로 기본값 /opt/web_service
./deploy.sh user@server /opt/web_service   # 경로 지정
```
`deploy.sh` 가 서브모듈을 최신으로 올리고 → 슈퍼레포 커밋·push → 서버에서
`git pull --recurse-submodules` + `docker compose up -d --build` + 이미지 정리까지 합니다.

**방법 B — 서버에서 직접:**
```sh
cd /opt/web_service
git pull --recurse-submodules
git submodule update --init --recursive
docker compose up -d --build
docker image prune -f
```

---

## 3. 백업 / 이전

상태는 **`PORTAL_DATA_DIR` 폴더 하나**가 전부입니다(계정 DB + 모든 서비스 데이터).
```sh
# 백업 (컨테이너 멈추고 뜨는 게 가장 안전)
docker compose stop
tar czf lilak-data-$(date +%F).tgz -C /srv/lilak data
docker compose start
```
다른 서버로 옮기려면: 그 서버에서 1번대로 설치하되, 이 tgz를 새 `PORTAL_DATA_DIR`
자리에 풀고 `docker compose up -d --build` 하면 계정·데이터가 그대로 살아납니다.

---

## 4. (선택) HTTPS / 리버스 프록시

포탈은 `:8025` 한 포트만 외부에 열립니다(서비스 포트는 내부). 공개 도메인 + TLS는
앞단에 nginx/Caddy를 두는 걸 권장합니다. Caddy 예시(`Caddyfile`):
```
portal.example.org {
    reverse_proxy localhost:8025
}
```
그리고 `.env` 의 `PORTAL_BASE_URL=https://portal.example.org` 로 맞추세요.

---

## 5. 트러블슈팅

| 증상 | 원인 / 해결 |
|---|---|
| `git clone --recursive` 가 Permission denied | 서버 SSH 키가 GitHub에 미등록. `ssh -T git@github.com` 로 확인 후 0번 참고 |
| 특정 서브모듈만 clone 실패 | 그 repo(private)에 키 접근권 없음. 계정/Deploy key 추가 |
| `docker compose` 없음 | Compose 플러그인 미설치. `docker compose version` 확인, 0번 재설치 |
| 포트 충돌(8025 사용 중) | `.env` 의 `PORTAL_PORT` 변경 후 `docker compose up -d` |
| 빌드는 됐는데 `/` 가 안 열림 | `docker compose logs portal` 확인. 대개 `.env` 시크릿 누락 |
| 데이터 폴더 권한 오류 | `PORTAL_DATA_DIR` 을 `chown "$USER"` 했는지 확인 |
| 가입이 막힘("초대코드 필요") | 첫 계정이 이미 만들어진 상태. 관리자로 로그인해 Account 탭에서 초대코드 발급/도메인 허용 |

> 참고: `g4toy`, `lilak_gui` 는 현재 스켈레톤이라 Docker 이미지에 빌드되지 않습니다(서브모듈로
> 받아만 둠). 실제 구현되면 `service_manager/deploy/Dockerfile` 에 빌드 단계를 추가하세요.
