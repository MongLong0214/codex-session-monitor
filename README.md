# Codex Session Monitor

로컬에서 실행 중인 Codex 작업을 읽기 전용으로 보여 주는 독립 GUI입니다.

- 메인 에이전트와 서브 에이전트 관계는 `~/.codex/state_*.sqlite`의 `thread_spawn_edges`에서 읽습니다.
- 실제 실행 프로세스는 macOS의 `ps`, `lsof`로 확인합니다.
- 최근 활동은 해당 세션의 롤아웃 JSONL 끝부분에서 읽습니다.
- 모든 HTTP 연결은 `127.0.0.1`에만 바인딩되며, 서버가 연 포트의 `Host` 헤더만 허용해 DNS 리바인딩 요청을 거부합니다. Codex 상태 DB와 로그를 변경하지 않습니다.

## 실행

```bash
cd /Users/isaac/WebstormProjects/codex-session-monitor
npm start
```

브라우저에서 `http://127.0.0.1:4177`을 엽니다. 기본 5초마다 자동으로 갱신되며, 상단 버튼으로 즉시 갱신할 수 있습니다.

같은 순간에 들어온 상태 요청은 하나의 읽기 작업으로 합치고, 결과는 최대 1초만 재사용합니다. 이 짧은 완충으로 상태 DB와 롤아웃 로그를 반복해서 동시에 읽지 않습니다. 상태 DB에서는 실행 중인 작업 디렉터리의 메인 세션과 그 하위 트리만 읽고, 실행 프로세스가 없을 때만 최근 메인 세션 최대 2개로 폴백합니다.

포트를 바꾸려면 다음처럼 실행합니다.

```bash
PORT=4288 npm start
```

## 검증

브라우저 E2E까지 실행하려면 의존성과 Chromium을 한 번 준비합니다.

```bash
npm install
npx playwright install chromium
npm test
```

E2E는 실제 `~/.codex` 상태를 읽지 않습니다. 고정된 스냅샷으로 메인·서브 트리, 접기·펼치기, 완료 필터, 새로 고침, 데스크톱 패널 겹침, 모바일 가로 오버플로, 빈 상태, API 상태 코드를 검증합니다.

## 요구 사항

- Node.js 20 이상
- macOS 기본 `ps`, `lsof`, `sqlite3`
- 로컬 Codex 상태 디렉터리 `~/.codex`

## 상태 해석

세션 트리는 SQLite의 부모·자식 에지로 정확하게 구성합니다. `closed` 하위 에지는 완료로 표시하고, 롤아웃의 `sub_agent_activity`(`started`/`interacted`)는 `agent_thread_id`가 가리키는 하위 에이전트의 최근 활동으로 반영합니다. 반면 프로세스와 세션 ID의 직접 매핑은 Codex 로컬 상태에 없으므로, 실행 여부는 같은 작업 디렉터리에서 관측된 Codex 프로세스로만 표시합니다. 화면의 `실행 관측`은 이 제한을 명시하는 상태입니다.
