# Codex Monitor

Codex CLI 로컬 상태를 읽어서 세션, 메모리, 통합, 토큰 흐름을 한눈에 보는 개인용 모니터입니다.

현재는 `Codex` provider를 기준으로 동작합니다. 설정 구조는 provider 단위로 나뉘어 있어서 이후 다른 도구를 붙일 여지는 열어둔 상태입니다.

## 화면 구성

### 대시보드

- 오늘 토큰 합계
- 최근 동기화 시각과 상태
- 최근 1년 활동 히트맵

### 세션

- 프로젝트별 세션 목록
- 검색, 정렬, 서브에이전트 포함 여부 필터
- 세션별 타임라인과 상세 이벤트

### 메모리

- `developer_instructions` 기반 개인 선호
- stage1 memory 추출 여부
- 세션 메모리 목록과 raw memory

### 통합

- MCP 서버, Skills, Hooks 인벤토리
- 최근 사용량과 상세 정보

### 토큰

- 최근 `7일`, `30일`, `90일` 일별 총 토큰 차트
- 모델 사용 비율 도넛 차트
- 프로젝트별 토큰 분포 버블 차트
- `일별`, `주별`, `월별` 기준 프로젝트 토큰 이동
- 최근 48시간 시간별 토큰 합계

## 데이터 원천

- 기본 데이터 원천은 `~/.codex`와 `~/.agents`입니다.
- 토큰 집계는 `~/.codex/sessions/**/*.jsonl`의 `token_count` 이벤트를 읽어 캐시합니다.
- 첫 동기화에서는 과거 rollout 로그를 백필하고, 이후에는 바뀐 파일만 다시 읽습니다.
- 프로젝트 토큰은 rollout의 `session_meta.cwd`와 thread 정보로 프로젝트를 복구해 집계합니다.
- 모델 사용 비율은 turn별 모델 정보를 따라가며 `token_count`를 모델 단위로 누적합니다.

## 실행

의존성 설치:

```bash
pnpm install
```

개발 서버:

```bash
pnpm dev
```

- API: `http://127.0.0.1:4318`
- Web UI: `http://127.0.0.1:4174`

프로덕션처럼 한 포트로 실행:

```bash
pnpm build
pnpm start
```

- 통합 서버/UI: `http://127.0.0.1:4318`

## 주요 명령

전체 검증:

```bash
pnpm test
pnpm typecheck
pnpm build
```

토큰 캐시 수동 동기화:

```bash
pnpm collector:snapshot
```

토큰 수집 launchd plist 생성:

```bash
pnpm collector:install-launchd
```

서버 자동 실행용 launchd plist 생성:

```bash
pnpm server:install-launchd
```

두 launchd 명령은 plist를 만든 뒤 `launchctl bootstrap ...` 예시를 출력합니다. 출력된 명령으로 직접 등록하면 됩니다.

## 환경 변수

| 이름 | 기본값 | 설명 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | API 바인드 주소 |
| `PORT` | `4318` | API 포트 |
| `MONITOR_DB` | `<repo>/data/monitor.sqlite` | 모니터 SQLite 경로 |
| `MONITOR_PROVIDER` | `codex` | 활성 provider. 현재 실제 지원값은 `codex` |
| `CODEX_HOME` | `~/.codex` | Codex 데이터 루트 |
| `AGENTS_HOME` | `~/.agents` | Agents 데이터 루트 |
| `CLAUDE_CODE_HOME` | `~/.claude` | 향후 provider 확장 대비 경로 |

## 구현 메모

- API 서버는 Fastify, 프론트는 React + Vite로 구성되어 있습니다.
- 토큰 페이지의 프로젝트 버블 차트는 `d3-hierarchy` 패킹 레이아웃으로 그립니다.
- 모델 사용 비율 차트는 `Recharts` 도넛 차트를 사용합니다.
- 정적 빌드가 있으면 API 서버가 `apps/web/dist`를 함께 서빙합니다.
