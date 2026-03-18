# Harness-Monitor Agent Guide

This file applies to the whole repository.

## Project Overview

- This repository is a monitoring UI for local Codex CLI activity.
- The codebase is split into `apps/api`, `apps/web`, and `packages/shared`.
- The API uses Fastify, the web app uses React + Vite, and shared schemas are defined with Zod.

## Working Style

- Do not stop at the visible symptom. Trace where the data comes from and where it is transformed.
- Decide early whether a change belongs only in the web layer or also needs API and schema updates.
- For token-related work, inspect `apps/api/src/lib/token-collector.ts` together with `packages/shared/src/schemas.ts`.
- For provider-related work, inspect `apps/api/src/config.ts`, `apps/api/src/lib/provider-registry.ts`, and `apps/api/src/lib/provider-adapter.ts` together.

## Common Commands

```bash
pnpm install
pnpm dev
pnpm test
pnpm typecheck
pnpm build
pnpm collector:snapshot
```

## Validation Rules

- The default validation order is `pnpm test`, `pnpm typecheck`, then `pnpm build`.
- If you touch responsive UI or layout, verify both narrow and wide widths directly.
- If you change API response shapes, update shared schemas and server tests in the same pass.

## Documentation Rules

- Only document features that the user can actually see in the current build.
- Do not mix “planned later” features with “already supported” features without labeling them clearly.
- Keep ports, paths, commands, and environment variable defaults aligned with the code.

## Commit Rules

- Keep each commit focused on one clear purpose.
- Write commit messages that explain why the change exists, not only what changed.
- If no remote is configured, do not guess a push target. Check remotes first.
