# Codex Monitor 작업 가이드

이 문서는 저장소 루트 아래 전체에 적용됩니다.

## 프로젝트 개요

- 이 저장소는 Codex CLI 로컬 상태를 읽는 모니터링 UI입니다.
- 구조는 `apps/api`, `apps/web`, `packages/shared` 세 영역으로 나뉩니다.
- API는 Fastify, Web은 React + Vite, 공용 스키마는 Zod 기반 shared 패키지에 있습니다.

## 작업 원칙

- 눈에 보이는 현상만 막지 말고, 데이터를 어디서 읽고 어디서 가공하는지 먼저 확인합니다.
- 프론트만 바꾸면 되는 문제인지, API 응답과 스키마까지 맞춰야 하는 문제인지 먼저 나눕니다.
- 토큰 관련 기능은 `apps/api/src/lib/token-collector.ts`와 `packages/shared/src/schemas.ts`를 함께 봅니다.
- provider 관련 변경은 `apps/api/src/config.ts`, `apps/api/src/lib/provider-registry.ts`, `apps/api/src/lib/provider-adapter.ts`를 같이 봅니다.

## 자주 쓰는 명령

```bash
pnpm install
pnpm dev
pnpm test
pnpm typecheck
pnpm build
pnpm collector:snapshot
```

## 변경 후 검증

- 기본 검증은 `pnpm test`, `pnpm typecheck`, `pnpm build` 순서로 합니다.
- Web 레이아웃을 건드렸다면 좁은 폭과 넓은 폭을 둘 다 직접 확인합니다.
- API 응답 구조를 바꿨다면 shared schema와 서버 테스트를 같이 맞춥니다.

## 문서화 원칙

- 사용자가 화면에서 실제로 볼 수 있는 기능만 README에 적습니다.
- 아직 준비만 된 기능과 실제 지원 기능을 섞어 쓰지 않습니다.
- 포트, 경로, 명령은 현재 코드 기준 값만 적습니다.

## 커밋 원칙

- 한 커밋에는 같은 목적의 변경만 묶습니다.
- 커밋 메시지는 무엇을 바꿨는지보다 왜 바꿨는지가 드러나게 씁니다.
- 원격 저장소가 없으면 임의로 push하지 말고, 먼저 remote 상태를 확인합니다.
