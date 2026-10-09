# reference_manager — 만들 것 / 만든 것

author_manager와 같은 구조, 데이터만 다른 서비스. 표·탭·선택·편집패널은
`lilak_ui/src/racklist`를 공유하므로, 여기 있는 것은 "논문에 대한 것"뿐이다.

## 데이터
```
references  citeKey type title journal volume pages year doi url
            authors[{name|ref, corr}]  tags[] cites[{n,ref,raw}] pdf links note
journals    name shortName abbrev        (ApJ / Astrophys. J.)
authors     id tag name aliases[] email orcid note
settings    PDF 허용 루트 목록 (매니저만)
```
저자는 **줄**이다 — 순서가 곧 저자 순서. 등록된 사람이면 `ref`로 연결되고 이름은
그 레코드에서 온다. BibTeX의 `author` 문자열은 저장하지 않고 이름들을 이어 만든다.
`corr`는 corresponding author 표시이며 1저자와 겹칠 수 있다.
분류는 **journals 하나**. 콜라보(SpiRIT …)와 주제 묶음(tpc · 12c · p1 · ai)은
태그다 — 똑같이 다대다이고 자기 필드가 없었다. 태그 목록은 논문들이 쓰는 것에서 모은다.
`cites: [{n, ref, raw}]` — 리스트에 있으면 `ref`, 없으면 `raw`. **cited by는 역산**.

## 단계
- [x] 1. kit `rack-list` 추출 (author_manager 재배선, 기능 변화 0)
- [x] 2. 뼈대 — 서비스 + 매니페스트 + 백엔드 + 포털 등록
- [x] 3. 목록 — 열·정렬·필터·검색·선택·나열 규칙, journals / tags 탭
        (My List 없음: 체크한 것이 그 자리를 대신한다)
- [x] 4. 가져오기 — List of Papers.xlsx → 261편 · 저널 55 · 태그 82
        (태그 69 + 콜라보 8 + 그룹 5가 합쳐진 결과)
- [x] 5. 편집기 — 오른쪽 전용 패널(자체 탭). 논문: 서지 필드 + 태그 + 링크 + 메모,
        **BibTeX/RIS 붙여넣기 파서**. 저널: 이름·짧은 이름·축약·발행처·issn·url,
        이름 변경은 논문들에 전파. 태그: 레코드가 없으니 이름 변경 = 전체 변경,
        이미 있는 이름을 넣으면 합치기, 삭제는 모든 논문에서 떼기. 매니저만 삭제.
- [x] 6. 인용 연결 — 편집기의 `참고문헌` 줄(번호 · 목록에서 찾기 · 없으면 글자),
        `인용한 논문`은 역산해서 보여주고 눌러서 이동. 표의 `cites`/`cited by`
        숫자를 누르면 그 논문들의 탭이 열린다(인용 번호 순).
- [x] 6.5 저자 클래스 — authors 탭(name · handle · papers · 1st · 2nd · corr. · 그 외),
        숫자를 누르면 그 역할의 논문 탭. 논문 편집기의 저자 칸은 한 줄에 한 명
        (`#handle` 또는 이름으로 연결, `등록`을 누르면 레코드를 만들고 같은 이름의
        줄을 전부 연결, corr. 체크, ↑↓로 순서). 저자 편집기에서 다른 표기(alias)를
        더하면 그렇게 적힌 줄도 연결된다.
- [x] 7. PDF — 로컬 경로 연결(찾기 · 끌어다 놓기 · 붙여넣기), 패널 탭 뷰어,
        `Finder에서 보기`, settings 탭의 허용 루트 + `루트를 훑어 연결`
- [ ] 7b. 업로드(문서에 저장)는 아직 — 지금은 디스크 경로만. 서버에 올려 쓸 때 필요
- [ ] 빈 PDF 29개 — 0바이트 파일이 원래부터 섞여 있다 (예: `AAndronic_PRC_2003.pdf`)
- [x] 6.6 cite key 자동 생성 — `{a1}_{jl}_{year}_{tag}`, 메인 태그는 태그 칩을
        눌러 고른다. 파일 이름에 못 쓰는 글자는 밑줄로. 새 논문만 자동, 기존 논문은
        `자동` 버튼을 눌렀을 때만
- [x] cite key 251개 전부 규칙대로 재생성 (177개 바뀜) + Dropbox PDF 299개를
      그 이름으로 변경 + 180편에 파일 연결 + `pdf` 열. 옛 키 ↔ 새 키 매핑은
      `key_map.tsv`, 되돌리기는 `undo_rename.sh`
- [ ] 원고의 `\cite{...}`는 옛 키를 쓰고 있다 — `key_map.tsv`로 치환해야 한다
- [ ] 파일이 없는 논문 **71편** · 목록에 없는 PDF **89개** (가져올지 정하기)
- [ ] 같은 PDF가 여러 폴더에 있는 논문 117편 — 사본을 정리할지
- [ ] 8. 출력 다듬기 — 프리셋 확인(short ref. · cite keys · \bibitem · BibTeX)

## 태그 표기 규칙
반응은 사람이 쓰는 대로 — `12C(p,p)12C` · `34Ar(a,p)37K` · `12C + 120Sn`.
밑줄은 엑셀 시절의 습관이라 공백으로 (`s process n capture`). 엑셀에서는 괄호와
쉼표가 수식 입력이 되는 열에 들어갈 수 없었다.

## 저자 정리 (2000명)
- [x] 이니셜/풀네임으로 갈라져 있던 같은 사람 80명 합침 (줄임이름·풀네임·
      BibTeX 표기를 한 레코드가 다 갖는다)
- [x] 각주 번호 제거 (`4 W. J. Ong`)
- [x] 성이 먼저인 표기 377개는 `bibName`으로 — BibTeX 출력이 이걸 쓴다
- [x] LaTeX 이스케이프 51개는 그대로 (.bib 표기라 고치면 인용이 깨진다)
- [ ] 이니셜만으로 동일인 판단이 안 된 것은 따로 남겨뒀다 — `Y. Kim`은
      `Kim, Youngman`일 수도 `Y.S. Kim`일 수도 있다. 아는 사람만 합치면 된다
      (저자 편집기에서 풀네임/다른 표기를 적고 저장하면 그 줄들이 연결된다)

## 저널 정리 (48개)
- [x] 제목과 약어로 두 번 들어와 있던 7개 합침 — `Physical Review C` + `Phys. Rev. C`
      (49+12 → **61**), `Physical Review Letter(s)` (20+6 → 26), `Review(s) of
      Modern Physics`, `Arxiv`/`arXiv`, `EPJ A`의 옛 부제, `JPS Conf. Proc.`,
      `PoS`/`Proceedings of Science`
- [x] `Physical Review C`의 짧은 이름이 `JPRC`였다 → `PRC`
- [x] 축약 이름 31개 채움 (ISO-4 식: `Nucl. Phys. A` · `Prog. Part. Nucl. Phys.` ·
      `Phys. Rep.` · `Nat. Commun.` · `J. Phys. G` …). 남은 하나는 PhDThesis
- [ ] `PhDThesis`(6편)는 저널이 아니다 — 논문 type이 이미 thesis다. 저널 칸을
      비우면 jl 열이 빈다는 점만 정하면 된다
- [ ] `Physical Review`(2편)의 짧은 이름이 `PRV`다. 표준은 `Phys. Rev.`이고
      `PR`은 이미 Physics Reports가 쓰고 있다
- [x] `PoS`의 축약 이름에 `NIC XII, PoS`가 들어 있었다 — 학회 이름은 저널이 아니라
      논문 쪽(volume) 정보다. `PoS`로 바꿨다
- [x] `Zeitschrift fur Physik` / `… A Hadrons and Nuclei`는 다른 시리즈로 보고 남김

## 가져오면서 남은 것
- [ ] 이름 없는 플래그 열 → 태그 **`unnamed column`** (논문 3편: X-ray burst
      sensitivity · MumpowerMR_PRC_2015 · SkyNet). 무슨 묶음인지 알면 이름 변경
- [x] 구체적인 태그는 일반 태그도 같이 (`s process n capture` → `s process`,
      `CRIB cryogenic gas target` → `CRIB`, `INDRA ALADIN` → `INDRA`)
- [x] `MasahideHARADA_JNST_1999`는 제목이 12C(p,p′3α)라 `12C(p,p)3a`로
- [x] `34Ar beam production` → `34Ar production`
- [x] `OpticalPotential` → `optical potential`, `HoyleState` → `Hoyle state`
- [x] `18Ne beam production`(1)은 그대로 — 34Ar처럼 합칠 상대가 없다
- [ ] `writing` 4편은 citeKey·제목이 없고 태그만 있음 (ELARK · 34Ar beam production ·
      Deblurring · KO2421)
- [x] 시트의 빈 줄 7개는 가져오지 않음 (그대로 두는 게 맞다)
