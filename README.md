# FoldBook - 나만의 3D 만화책 뷰어 (React + TypeScript + PWA)

갤럭시 폴드 & 네이버 만화책 스타일의 **3D 책장 넘김(Page Curl/Flip)** 모션과 **폴더 통째로(뭉탱이) 불러오기**, **Chrome 앱 설치(PWA)**, **GitHub Pages 무료 자동 배포**를 지원하는 웹앱입니다.

## 주요 기능
- **폴더 통째로 로드 (`webkitdirectory`) & 다중 사진 선택 & 드래그 앤 드롭**: 파일명 숫자 순(`1, 2, ... 10, 19502.jpg`)으로 자동 정렬
- **갤럭시 폴드 8 스타일 3D 책 넘김 모션**: 마우스 드래그/터치 스와이프 각도에 반응하는 실시간 3D 페이지 회전 및 중앙 제본선(Crease) 음영
- **읽기 방향 및 분할 모드**:
  - **만화책 방향 (우→좌)**: 오른쪽 페이지(예: 128p) → 왼쪽 페이지(예: 129p) 순서로 읽고 왼쪽 페이지를 넘겨 다음 장으로 이동
  - **일반책 방향 (좌→우)**: 왼쪽 페이지 → 오른쪽 페이지 순서로 읽고 오른쪽 페이지를 넘겨 다음 장으로 이동
  - **양면 폴드북 / 반쪽 자동분할 / 단면 2장 합치기** 모드 지원
- **Chrome 앱 설치 (PWA)**: `vite-plugin-pwa`가 적용되어 있어 배포된 URL 접속 시 크롬 주소창 우측의 **[앱 설치]** 버튼으로 PC/모바일에 네이티브 앱처럼 설치 가능

## GitHub (`https://github.com/jacky92q/book-viewer`) 자동 배포 방법

1. 이 프로젝트 폴더에서 아래 명령어로 GitHub 저장소에 푸시합니다:
   ```bash
   git init
   git remote add origin https://github.com/jacky92q/book-viewer.git
   git branch -M main
   git add .
   git commit -m "feat: initial FoldBook 3D comic viewer with PWA & auto-deploy"
   git push -u origin main
   ```
2. GitHub 저장소 페이지의 **Settings → Pages** 메뉴로 이동합니다.
3. **Build and deployment → Source**를 **GitHub Actions**로 변경합니다.
4. 이제 코드를 수정하고 `git push`할 때마다 `.github/workflows/deploy.yml`이 자동 실행되어 아래 무료 주소로 자동 배포됩니다:
   - 배포 URL: `https://jacky92q.github.io/book-viewer/`
