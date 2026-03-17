# Codex Monitor

Codex CLI의 로컬 상태를 읽어 보는 개인용 Web UI입니다.

다음 정보를 확인할 수 있습니다.

- 세션 목록과 세션별 대화 타임라인
- 메모리 모드와 stage1 memory 추출 상태
- MCP 서버, Skills, Hooks 인벤토리
- `token_count` 로그 기반 일별 토큰 사용량 추세

## 실행

```bash
pnpm install
pnpm dev
```

- API: `http://127.0.0.1:4318`
- Web UI: `http://127.0.0.1:4174`

프로덕션처럼 한 포트에서 보려면:

```bash
pnpm build
pnpm start
```

## 토큰 동기화

수동 동기화:

```bash
pnpm collector:snapshot
```

launchd 설치 파일 생성:

```bash
pnpm collector:install-launchd
```

생성 후 출력되는 `launchctl bootstrap ...` 명령으로 직접 등록하면 됩니다.

서버를 로그인 후 자동 실행하려면:

```bash
pnpm server:install-launchd
```

이 역시 출력되는 `launchctl bootstrap ...` 명령으로 등록하면 됩니다.

## 참고

- 토큰 추세는 `~/.codex/sessions/**/*.jsonl`의 `token_count` 이벤트를 시간/일 단위로 캐시해 계산합니다.
- 첫 동기화에서는 과거 rollout 로그를 읽어 백필합니다.
- 이후에는 변경된 rollout 파일만 다시 읽습니다.
- 기본 데이터 원천은 `~/.codex`와 `~/.agents`입니다.
