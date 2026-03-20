# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Codex CLI 활동을 모니터링하는 로컬 대시보드. `~/.codex`, `~/.agents` 데이터를 읽어 세션, 메모리, 토큰 사용량을 웹 UI로 보여준다.

## Monorepo

- **apps/api** — Fastify 백엔드. 프로덕션에서는 웹 빌드도 서빙.
- **apps/web** — React + Vite 프론트엔드. 개발 시 `/api`를 4318로 프록시.
- **packages/shared** — API·웹 공유 Zod 스키마.

패키지 매니저: **pnpm** (workspace protocol).

## Commands

```bash
pnpm dev                    # API(4318) + Web(4174) 동시 실행
pnpm test                   # vitest (API 테스트)
pnpm typecheck              # tsc 전체
pnpm build                  # API tsc + Web vite build
pnpm collector:snapshot     # 토큰 캐시 수동 동기화
```

단일 테스트:
```bash
pnpm --filter @codex-monitor/api exec vitest run src/lib/token-collector.test.ts
```

## Architecture

Provider 추상화(`MonitorProviderAdapter`)로 데이터 소스를 분리. 현재 `CodexDataService`만 구현됨.

`token-collector.ts`가 `~/.codex/sessions/**/*.jsonl`을 `data/monitor.sqlite`(Node.js 내장 `DatabaseSync`)로 인덱싱. 증분 동기화로 변경된 파일만 재처리.

```
~/.codex, ~/.agents → API(Fastify) → React UI
```

## Working Conventions

- 증상에서 멈추지 말고 데이터의 출처와 변환 과정을 끝까지 추적할 것.
- 변경이 웹 전용인지, API + 스키마까지 필요한지 먼저 판단할 것.
- API 응답 형태를 바꾸면 shared Zod 스키마와 서버 테스트를 같이 수정할 것.
- UI/레이아웃 변경 시 좁은 폭과 넓은 폭 모두 확인할 것.
- 검증 순서: **test → typecheck → build**.
- 커밋은 하나의 목적만. *what*이 아닌 *why*를 설명할 것.

## Key File Groups

- 토큰: `token-collector.ts` + `packages/shared/src/schemas.ts`
- Provider: `config.ts` + `provider-registry.ts` + `provider-adapter.ts`
