# reference manager

논문 목록을 관리하는 LILAK 포털 서비스. 화면 전체가 표 하나다 — 찾는 일이
주업이고, 읽고 쓰는 일은 오른쪽 편집 패널에서 한다.

author_manager와 **같은 구조의 서비스**다. 표·탭·선택·열 너비·⌘F·상태줄·뷰 상태·
포털 문서 입출력은 공유 부품(`lilak_ui/src/racklist`)이고, 여기 있는 코드는
"논문에 대한 것"뿐이다. 그래서 스타일 한 줄을 고치면 두 서비스가 같이 변한다.

## 문서 하나, 통째로 저장

프로젝트마다 `data.json` 하나. `version`을 달고 있고, 저장할 때 자기가 편집을
시작한 `baseVersion`을 보낸다. 그 사이 누가 먼저 저장했으면 409로 거절되고
최신 문서를 돌려받는다 — 조용히 덮어쓰는 일이 없다.

```
references  논문
journals    저널 (자기 필드가 있는 유일한 분류)
authors     저자
settings    서비스 설정 (PDF 허용 루트 등, 매니저만)
```

태그는 목록이 없다. **논문들이 쓰는 단어를 모아** 보여줄 뿐이다.

## 논문

```
citeKey type title journal volume pages year doi url
authors[] tags[] cites[] pdf links note
```

`type`은 paper · thesis · report · writing.

**계산되는 것은 저장하지 않는다.** 시트에 열로 있던 `short ref.`, 저자 1·2·3,
`a1`, BibTeX 블록은 전부 나열 규칙(아래)으로 만든다. 한 곳에만 적혀 있으면
어긋날 수가 없다.

### 저자는 줄이다

표와 편집기는 **풀네임이 있으면 풀네임**을 보여준다 — `Jung Woo Lee`는 누구인지
바로 알지만 `J. W. Lee`는 한 번 더 생각하게 한다. 인용과 **cite key는 줄임이름**을
쓴다 (`{abv author}`, `{a1}`): 키는 인용이고, 풀네임을 따라가면 `AKarakas`가
어느 날 `AIKarakas`가 된다.

```js
authors: [ { name: 'C. Y. Tsang', ref: '<author id>', corr: false }, … ]
```

순서가 곧 저자 순서. `ref`가 있으면 등록된 사람이고, 이름은 그 레코드에서 온다.
`corr`는 corresponding author 표시다. BibTeX가 쓰는 `"A and B and C"` 문자열은
**저장하지 않고** 이 줄들을 이어 만든다.

편집 화면은 **3명까지** 보여주고 나머지는 `열기`로 펼친다 — 279명짜리 논문(LIGO)이
실제로 있다.

### cite key는 규칙이 쓴다

종류마다 규칙이 다르다. 키는 그것이 **무엇인지** 말해야 하는데, 제안서는 저널이
아니라 기관의 위원회로 가기 때문이다.

| 종류 | 규칙 | 예 |
|---|---|---|
| paper · thesis · report | `{a1}_{jl}_{year}_{tag}` | `MBTsang_PRC_2001_isoscaling` |
| **proposal** | `{inst}_PAC{pac}_{year unless pac}_{a1}_{tag}` | `RIKEN_PAC27_2026_JWLee_STARK` |

`pac`은 PAC 뒤에 그대로 들어가는 값이다 — RIKEN은 회차를 센다(PAC27), RAON과
JYFL은 해를 쓴다(2026). 추측하지 않고 레코드가 들고 있다. 그래서 해는
`{year unless pac}`으로 들어간다: PAC 번호가 이미 해이면 두 번 말하지 않는다
(`RAON_PAC2026_JWLee`), 다르면 바로 뒤에 붙는다 (`RIKEN_PAC27_2026_JWLee`). 기관은 표의 journal
열에 함께 나온다: 둘 다 "어디로 갔는가"다.

`settings.keyRules`에 종류별로 적으면 기본 규칙을 덮어쓴다.

공통 부분: `{a1}`은 첫 저자의 handle, `{tag}`는 **메인 태그**.
키는 **파일 이름이기도 해서** 각 조각을 파일 이름이 담을 수 있는 글자로 줄인다:
문장부호는 사라지지 않고 밑줄이 된다 (`12C(p,p)12C` → `12C_p_p_12C`,
`X-ray burst` → `X-ray_burst`) — 시트가 이미 쓰던 그 표기다. 빈 조각은 빈 자리를
남기지 않는다.

메인 태그는 논문의 태그 중 하나를 **눌러서** 정한다 (겨자색이 메인). 안 고르면
첫 번째 것.

**새 논문만** 자동으로 채워진다. 이미 있는 논문은 그 이름으로 파일이 저장돼 있으니
건드리지 않는다 — cite key 칸의 `자동` 버튼을 눌렀을 때만 바뀐다. 같은 키가 이미
있으면 막지 않고 말해준다 (같은 저자·저널·해 논문은 실제로 있다).

### 인용은 한 방향만 저장한다

```js
cites: [ { n: 5, ref: '<paper id>', raw: '' },
         { n: 6, ref: '', raw: 'J. Doe et al., PRC 99 (2019) 014601' } ]
```

`n`은 그 논문에서의 인용 번호. 목록에 있는 논문이면 `ref`로 연결하고, 없으면
`raw`에 글자로 남긴다 — 연결 못 하는 인용도 인용이다.

**"이 논문을 인용한 논문"은 저장하지 않는다.** `cites[].ref`를 거꾸로 세서 만든다.
두 방향을 다 저장하면 어긋날 수 있는 곳이 두 곳이 된다.

표의 `cites` · `cited by` 숫자는 **눌러서 그 논문들의 탭**을 여는 버튼이다.

## 저자

```
id tag name fullName bibName aliases[] email orcid note
```

한 사람이 이름 세 개를 갖는다. 논문이 자리마다 다른 표기를 필요로 하기 때문이다.

| 필드 | 예 | 쓰이는 곳 |
|---|---|---|
| `name` (줄임이름) | `W. G. Lynch` | 표, 인용, `{author}` |
| `fullName` (풀네임) | `William G Lynch` | 사람을 특정할 때 |
| `bibName` (BibTeX 표기) | `Lynch, W. G.` | `{author (bib)}` → .bib 출력 |

`name`만 필수다. 편집기의 `줄임이름으로` 버튼이 풀네임이나 BibTeX 표기에서
줄임이름을 만든다 (`van der Klis, Michiel` → `M. van der Klis`,
`Ying-Xun Zhang` → `Y.-X. Zhang` — 붙임표 이름은 이니셜을 둘 다 남긴다).

### handle과 연결

`tag`는 `#WGLynch` 같은 손잡이다. 이니셜 + 성으로 만들고(시트의 `a1` 열과 같은
방식), 다른 사람과 겹치면 숫자를 붙이는 대신 **풀네임 쪽이 길게 간다** —
`WilliamGLynch`가 `WGLynch2`보다 읽힌다.

논문의 저자 줄은 **`#handle` · 줄임이름 · 풀네임 · BibTeX 표기 · `aliases`의 어떤
표기로든** 연결된다. 저자 레코드를 저장하면 그 표기로 적혀 있던 줄들이 그때 연결된다.

아직 등록되지 않은 이름 옆의 `등록`을 누르면, 레코드를 만들고 **모든 논문에서 같은
이름으로 적힌 줄을 한 번에 연결**한다. 한 번 눌러 44줄이 연결된 적이 있다.

### 역할별 숫자

authors 탭은 `papers · 1st · 2nd · corr. · 그 외`를 센다. 역할은 **배타적이지
않다** — 1저자이면서 corresponding일 수 있고, 두 목록 다 그렇다고 말해야 한다.
`그 외`는 3번째 이후이면서 corresponding이 아닌 경우다. 숫자를 누르면 그 역할의
논문만 담긴 탭이 열린다.

## 나열 규칙

버튼이 글자를 만드는 게 아니라 **템플릿을 채우고, 템플릿이 글자를 만든다.**
토큰은 열 이름이다: `{cite key}` `{title}` `{author}` `{author (bib)}`
`{first author}` `{et al.}` `{jl}` `{journal}` `{volume}` `{pages}` `{year}`
`{doi}` `{url}` `{short ref}` `{tags}`.

프리셋은 short ref. · cite keys · `\bibitem` · BibTeX. BibTeX는 별 장치 없이
템플릿만으로 나온다 — 바깥 중괄호는 글자이고 안쪽 `{token}`만 토큰이라
`author = {{author (bib)}}` 가 `author = {Tsang, C. Y. and …}` 가 된다.

프리셋을 고른 뒤 규칙을 고치면 글자가 손밑에서 바뀐다. 아무도 모르는 토큰은
비우지 않고 그대로 남겨서, 오타가 보이게 한다.

## PDF

논문 레코드의 `pdf`는 `{ mode: 'path', path, copies[] }` — 디스크의 파일이다.
브라우저는 `http://` 페이지에서 `file:///`를 못 열기 때문에 **서비스가 대신
읽어준다**: `GET /api/file?path=…`.

**허용 루트** (`settings.pdfRoots`, settings 탭에서 매니저만) 안의 파일만 읽는다.
경로는 심볼릭 링크까지 풀어서 확인하므로 루트 밖을 가리키면 거부된다. 백엔드가
그 파일들이 있는 컴퓨터에서 돌 때만 동작한다 — 서버에 올리면 그 파일은 안 보인다.

링크를 만드는 방법 세 가지:

| | |
|---|---|
| **찾기 / 루트를 훑어 연결** | 파일 이름이 cite key와 같으므로 루트를 훑어 맞춘다 |
| **Finder에서 끌어다 놓기** | 드롭하면 `file://` URL이 오고, 거기서 경로를 읽는다 |
| **경로 붙여넣기** | Finder의 ⌥⌘C가 경로를 복사한다 |

파일 선택 창은 쓸 수 없다 — 브라우저가 웹 페이지에 경로를 주지 않는다.

표의 `pdf` 열은 ✓ 하나다. 누르면 편집 패널에 PDF 탭으로 열린다. 그 안에서:

| | |
|---|---|
| 경로 | 누르면 클립보드로 |
| `폴더에서 보기` | 백엔드가 **보고 있는 그 컴퓨터일 때만** 나온다 (localhost). macOS `open -R` · Windows `explorer /select,` · Linux는 파일 관리자의 D-Bus `ShowItems`, 없으면 폴더를 연다 |
| `새 창` · `내려받기` | 다른 컴퓨터의 서버일 때 파일에 닿는 길. `?download=1`이면 첨부로 내려간다 |

## 데이터는 어디서 왔나

`List of Papers.xlsx` (Papers 261줄 · journals 50줄). 빈 줄 7개는 가져오지 않았다.
시트의 `co`(콜라보레이션)와 플래그 열(`tpc` `12c` `p1` `ai`)은 **태그로 합쳤다** —
똑같이 다대다이고 자기 필드가 없었다. `latex extractor` 시트가 하던 일은
**BibTeX/RIS 붙여넣기 파서**가 대신한다.

이름은 손대지 않은 것이 있다. LaTeX 이스케이프(`B. B\'ecsy`)는 .bib 파일에서
그렇게 쓰는 표기라 그대로 둔다. 성이 먼저인 표기는 `bibName`에 들어간다.

## 손으로 확인할 때

```bash
cd ~/web_service/reference_manager
LILAK_UI_PATH=~/web_service/lilak_ui npx vite build
python3 _check.py            # 실제 문서를 포털 밖에서 띄우는 임시 하니스
cd dist && python3 -m http.server 8124   # → /_check.html (?role=user 로 비매니저 확인)
```

`_check.py`는 앱의 것이 아니다. 가짜 백엔드(버전 가드 포함)를 물려서 브라우저에서만
편집이 일어난다 — 실제 문서는 건드리지 않는다.
