# 테트리스 배틀 - 실시간 서버 (WebSocket)

기존 브라우저 전용(공유 저장소 폴링) 버전과 달리, Node.js WebSocket 서버가
모든 클라이언트를 실시간으로 연결해서 지연을 크게 줄인 버전입니다.
(폴링 0.5~0.7초 → WebSocket 방식은 보통 수십 ms 수준)

## 실행 방법 (내 PC에서 테스트)

1. [Node.js](https://nodejs.org) 설치 (18버전 이상 권장)
2. 이 폴더에서 터미널 열고:
   ```
   npm install
   npm start
   ```
3. 브라우저에서 `http://localhost:3000` 접속
4. 같은 컴퓨터의 다른 브라우저 탭 3개를 더 열어서 같은 방 코드로 참가하면
   4인 테스트 가능

## 같은 집/사무실(같은 Wi-Fi)에서 여러 명이 하기

1. 서버를 실행한 PC의 로컬 IP 확인 (Windows: `ipconfig`에서 IPv4 주소, 보통 `192.168.x.x`)
2. 같은 Wi-Fi에 연결된 친구들이 `http://192.168.x.x:3000` 접속
3. 방화벽에서 3000번 포트 허용 필요할 수 있음

## 인터넷 너머(다른 장소)에서 여러 명이 하기

같은 공유기 안이 아니라면, 서버가 외부에서 접속 가능한 주소에 떠 있어야 해요.
직접 포트포워딩을 설정하거나, 아래 같은 무료/저가 호스팅에 이 폴더를 그대로
배포하면 됩니다 (모두 Node.js + WebSocket을 지원):

- Render.com (Web Service, 무료 티어 있음)
- Railway.app
- Fly.io

배포 후 발급되는 주소(예: `https://your-app.onrender.com`)를 친구들에게
공유하면 끝입니다. 코드 수정은 필요 없어요 (클라이언트가 자동으로 같은
호스트에 WebSocket 연결).

## 창모드 exe로 만들고 싶다면 (선택)

이 서버가 정상 동작하는 걸 확인한 뒤, `public/index.html`을 Electron으로
감싸면 "더블클릭으로 실행되는 창모드 앱"을 만들 수 있어요. 이때도 게임
로직/네트워킹은 지금과 동일하고, Electron은 그냥 크롬을 내장해서 아이콘화
해주는 역할이에요. 필요하면 이 프로젝트를 기반으로 Electron 패키징도
도와드릴 수 있어요.

## 파일 구성

```
tetris-server/
  package.json       - 의존성 (ws 패키지)
  server.js          - WebSocket 서버 (방 관리, 상태 릴레이, 공격 라우팅)
  public/index.html  - 클라이언트 (게임 로직 + UI + WebSocket 통신)
```
