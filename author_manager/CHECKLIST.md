# author_manager — 다시 채운 기능 목록

서비스를 표 하나로 새로 만든 뒤, 원래 있던 기능을 하나씩 되살리며 지운 목록.
대화에만 있던 것을 파일로 옮겨 적은 것이라 여기가 원본이다.

## A. 목록 (done)
- [x] 표: 소속 · 이름 · name · abv-name · email · position · core
- [x] 열 너비 드래그, 브라우저에 기억 (`am.cols.<project>`)
- [x] 좁아지면 열이 빠짐 (abv-name 1040px, position 860px)
- [x] 체크박스 선택, shift로 범위 선택, 머리 체크박스로 전체 선택·해제
- [x] ⌘F/Ctrl+F → 표 안 검색창
- [x] 레이블 칸을 눌러 정렬 (기본 한글 이름 순, 누를 때마다 방향 반전)
- [x] 필터 선택 모드 → 레이블에서 값 고르기 → 필터 적용 / 풀기
- [x] 탭: total · my list · groups · affiliation, 그 뒤에 열리는 탭은 다른 색 + ×

## B. My List (done)
- [x] add to my list / clear, 브라우저에 기억 (`am.mylist.<project>`)
- [x] add to group — 기존 그룹 목록에서 골라 담기
- [x] make group — 고른 사람으로 새 그룹
- [x] empty my list
- [x] 나열 규칙: `{열이름}` 토큰을 쓰는 편집 가능한 템플릿, 프리셋 4종(이름 나열 /
      full names / abv. names / email list), 기본 접힘, 그룹·소속 탭에서도 보임
- [x] paper authors — 윗첨자 붙은 LaTeX 저자 블록 (규칙 바깥)

## C. 저자 편집 (done)
- [x] 오른쪽 편집 창, 자기 탭을 따로 가짐 (1180px 이상이면 목록과 나란히)
- [x] 새 저자 / 고치기 / 지우기(제자리 2단 확인), 매니저만
- [x] 이름(한글·영문·abv) · 대표메일 · 메일 여러 개 · 전화 · 링크 · 첨부
- [x] 소속 줄: tag · 부서 · 직위 · 메일 · since
- [x] 그룹 줄: group · role · core
- [x] 빈 줄은 저장 때 버림

## D. 분류(소속·그룹) 등록 (done)
- [x] groups / affiliation 탭에서 목록, 레이블 눌러 정렬
- [x] + 새 소속 / + 새 그룹 (탭 전용 겨자색)
- [x] 이름 · 짧은 이름 · 전체 이름 · 주소 · 전화 · 설명 · 기간 · 링크
- [x] 이름을 바꾸면 그 분류를 쓰는 저자들도 같이 바뀜
- [x] 지우기: 쓰는 사람 수를 보여주고 제자리 2단 확인

## E. 기억하는 것 (done)
- [x] 열 너비 `am.cols.<project>` · My List `am.mylist.<project>`
- [x] 정렬 · 분류 정렬 · 적용된 필터 · 열어둔 탭 · 보고 있던 탭 `am.view.<project>`
      (필터 선택 모드와 나열 서랍은 돌아올 상태가 아니라 저장하지 않음)
- [x] 없어진 그룹·소속의 탭은 문서를 읽은 뒤 사라지고, 거기 있었으면 total로

## 데이터 쪽 남은 것
- [ ] 영문 이름이 없는 저자: 박정혁(abv `J. Park`), 남선호(abv `S.H. Nam`)
- [ ] 김민주 두 명 — 이메일·소속이 달라 합치지 않음 (Ehwa / TOPTIER)
- [ ] 분류 레코드의 사진·첨부: 화면에는 있고 실제 문서는 아직 name/fullName만 씀
