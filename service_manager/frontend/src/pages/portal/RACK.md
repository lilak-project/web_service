# RACK

포털 화면의 공통 어휘. 회색 바닥에 흰 모듈이 위아래로 꽂히고, 모듈마다 색
명판이 붙습니다 — 19인치 랙에 꽂힌 계측 모듈과 같은 구조라 **RACK** 이라
부릅니다.

## 규칙 셋

1. 화면은 **회색 바닥**입니다. 내용이 바닥에 직접 놓이지 않고 흰 **모듈** 위에 놓입니다.
2. 모듈의 제목은 위에 떠 있는 제목이 아니라 **명판**(`.set-bar`)입니다. 화면에서 굵은 글자는 그것뿐입니다.
3. 모듈 안은 전부 한 크기의 **줄**입니다. 사실은 **표**(`.set-card`), 기록 목록은 **채널**(`.set-row`). 세로줄은 긋지 않습니다.

되돌릴 수 없는 것은 한 화면에 하나, 맨 아래, 빨간 명판 모듈로 모읍니다.

## 부품

| 부품 | 클래스 | 컴포넌트 | 무엇 |
|---|---|---|---|
| 모듈 | `.set-panel` | `Panel` | 바닥 위의 흰 상자 |
| 명판 | `.set-bar` | `Panel`의 `title`/`strip` | 모듈의 제목이자 종류 표시 |
| 표 | `.set-card` | `Field` · `FieldActions` | 이름/값 두 칸 격자 |
| 채널 | `.set-row` | `Row` | 기록 한 건 |
| 표시등 | `.set-pill` | `Pill` | 상태 |

부품은 전부 [`Field.jsx`](Field.jsx), 생김새는 [`settings.css`](settings.css),
화면 아래 한 줄짜리 알림은 [`settingsMsg.jsx`](settingsMsg.jsx).

## 명판 색

색이 화면의 종류를 말합니다.

| 명판 | 값 | 무엇 |
|---|---|---|
| 파랑 | `--info-bg` | 설정 — 내 계정, 그룹, 초대, 시스템, 로그인 |
| 보라 | `--plate-manage` `#ede9fe` | 관리 — 서비스·그룹을 고쳐 쓰는 화면 |
| 먹색 | `--plate-tool` `#3d4b5f` + 반전 글자 | 도구 — 포털 자신을 다루는 붙박이 |
| 빨강 | `--danger-bg` | 되돌릴 수 없는 것 |

## 치수

명판 34px · 줄 좌우 13px · 버튼과 입력 28px · 모듈 사이 8px · 글자 한 크기 `--fs-medium`.

손잡이는 넷이고, 전부 `settings.css` 의 `:root` 에 있습니다.

| 변수 | 값 | 무엇 |
|---|---|---|
| `--rack-col` | 760px | 화면의 칸 너비. 모든 랙 화면이 이 칸으로 가운데 정렬되고, 화면 이름도 그 위에 가운데로 앉습니다 |
| `--rack-row` | 32px | 줄 높이. 채널(`.set-row`)에는 **바닥**(칩 목록이나 긴 글은 늘어납니다), 표 줄(`.set-row.cols`)에는 **고정** — 넘치면 말줄임 |
| `--rack-head` | 24px | 머리줄 높이 |
| `--rack-radius` | 0 | 모서리 |

랙은 볼트로 조인 쇠붙이라 전부 직각입니다. **판 안뿐 아니라 포털 전체** — 사이드바
카드와 아이콘 타일, 메뉴, 클래식 커버까지 같은 값을 씁니다 (`sidebar.css` 의
`--radius-md`/`--radius-lg` 도 여기에 묶여 있습니다).

둥근 채로 두는 것은 **둥근 물건을 그리는 것들**뿐입니다 — 표시등(`.set-pill`)의
둥근 끝은 그 모양이 곧 그 부품이고, 아바타와 아이콘 랩의 앱 아이콘 미리보기는
지금 디자인 중인 물건이지 크롬이 아닙니다.

모서리를 되살리려면 `--rack-radius` 하나만 바꾸면 됩니다.

## 랙에 꽂힌 화면

`scripts/rack.py --write` 가 만들고 `--check` 가 지킵니다. 명판 칸만 손으로 채웁니다.

<!-- rack:begin -->

| 화면 | 명판 | 부품 |
|---|---|---|
| `ProjectsPage.jsx` | 파랑 | 모듈·표 |
| `portal/AccountView.jsx` | 파랑 | 모듈·표·채널·표시등 |
| `portal/FeedbackView.jsx` | 파랑 | 모듈·채널·표시등 |
| `portal/GroupManagePanel.jsx` | 보라 | 모듈·표·채널·표시등 |
| `portal/GroupsAdmin.jsx` | 파랑 | 모듈·표·채널 |
| `portal/GuideView.jsx` | 파랑 | 모듈 |
| `portal/HandshakeRegister.jsx` | — | 모듈 |
| `portal/IconLabView.jsx` | 먹색 | 모듈·표·채널 |
| `portal/InvitesAdmin.jsx` | 파랑 | 모듈·표·채널·표시등 |
| `portal/LinksView.jsx` | 먹색 | 모듈·채널 |
| `portal/NewServiceView.jsx` | 먹색 | 모듈·표·채널·표시등 |
| `portal/RackView.jsx` | 먹색 | 모듈·명판·표·채널·표시등 |
| `portal/ServiceManagePanel.jsx` | 보라 | 모듈·표·채널·표시등 |
| `portal/ServiceProjects.jsx` | 보라 | 모듈·표·채널·표시등 |
| `portal/ServiceSingle.jsx` | 보라 | 모듈·표·표시등 |
| `portal/StoreView.jsx` | 먹색 | 모듈·표·채널·표시등 |
| `portal/SystemAdmin.jsx` | 파랑 | 모듈·표·표시등 |

<!-- rack:end -->

`—` 는 아직 어느 화면에도 걸려 있지 않은 모듈입니다.

## 룰을 바꿀 때

1. `Field.jsx` 나 `settings.css` 를 고칩니다.
2. `python3 scripts/rack.py --check` — 표가 어긋나면 알려줍니다.
3. 표의 화면을 전부 한 번씩 열어봅니다. 명판 색이 셋이므로 최소 세 장.
4. 화면을 새로 만들거나 지웠으면 `--write` 로 표를 갱신하고 명판 칸을 채웁니다.

`⚠직접마크업` 표시는 `Field.jsx` 의 부품을 쓰지 않고 `set-` 클래스를 직접
그린 화면입니다 — 부품을 고쳐도 따라오지 않으니 먼저 부품으로 되돌리세요.
