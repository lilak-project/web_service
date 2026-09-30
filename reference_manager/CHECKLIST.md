# reference_manager — 만들 것 / 만든 것

author_manager와 같은 구조, 데이터만 다른 서비스. 표·탭·선택·편집패널은
`lilak_ui/src/racklist`를 공유하므로, 여기 있는 것은 "논문에 대한 것"뿐이다.

## 데이터
```
references     citeKey type title author journal volume pages year doi url
               tags[] collaboration groups[] cites[] pdf links attachments note
journals       name shortName abbrev      (ApJ / Astrophys. J.)
collaborations name shortName fullName
groups         name shortName fullName    (다대다: tpc · 12c · p1 · ai …)
settings       PDF 허용 루트 목록 (매니저만)
```
`cites: [{n, ref, raw}]` — 리스트에 있으면 `ref`, 없으면 `raw`. **cited by는 역산**.

## 단계
- [x] 1. kit `rack-list` 추출 (author_manager 재배선, 기능 변화 0)
- [x] 2. 뼈대 — 서비스 + 매니페스트 + 백엔드 + 포털 등록
- [x] 3. 목록 — 열·정렬·필터·검색·선택·My List·나열 규칙,
        journals / collaborations / groups / tags 탭
- [x] 4. 가져오기 — List of Papers.xlsx → 261편 · 저널 55 · 콜라보 8 · 그룹 5 · 태그 69
- [ ] 5. 편집기 — 서지 필드 + BibTeX/RIS 붙여넣기 파서, 분류 편집(이름 변경 전파)
- [ ] 6. 인용 연결 — `cites` 줄 + 피커, cites/cited by 열에서 탭 열기, 논문 간 점프
- [ ] 7. PDF — 업로드 + 로컬 경로 연결, 패널 탭 뷰어, 설정 탭에서 허용 루트 관리
- [ ] 8. 출력 다듬기 — 프리셋 확인(short ref. · cite keys · \bibitem · BibTeX)

## 가져오면서 남은 것
- [ ] 이름 없는 플래그 열 → 그룹 **`unnamed column`** (논문 3편: X-ray burst
      sensitivity · MumpowerMR_PRC_2015 · SkyNet). 무슨 묶음인지 알면 이름 변경
- [ ] 저널 55개 중 **34개가 축약명 없음** (`abbrev`) — 인용 출력에서는 전체 이름이 나옴
- [ ] `writing` 4편은 citeKey·제목이 없고 태그만 있음 (ELARK · 34Ar beam production ·
      Deblurring · KO2421)
- [ ] 시트의 빈 줄 7개는 가져오지 않음
