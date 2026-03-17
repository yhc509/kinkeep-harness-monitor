import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { CodexDataService } from "./codex-service";
import { TokenCollectorService } from "./token-collector";
import { createTestFixture } from "../test-support/fixture";

const fixtures: Array<ReturnType<typeof createTestFixture>> = [];

afterEach(() => {
  while (fixtures.length > 0) {
    fixtures.pop()?.cleanup();
  }
});

describe("TokenCollectorService", () => {
  it("rollout 로그의 token_count 이벤트를 일별/시간별 사용량으로 집계한다", () => {
    const fixture = createTestFixture();
    fixtures.push(fixture);

    const codex = new CodexDataService(fixture.config);
    const collector = new TokenCollectorService(fixture.config, codex);

    collector.captureSnapshot(new Date("2026-03-14T10:05:00+09:00"));

    const tokens = collector.getTokens(1, new Date("2026-03-14T19:10:00+09:00"));
    expect(tokens.daily[0]?.totalTokens).toBe(140);
    expect(tokens.daily[0]?.inputTokens).toBe(100);
    expect(tokens.daily[0]?.cachedInputTokens).toBe(20);
    expect(tokens.daily[0]?.uncachedTokens).toBe(120);
    expect(tokens.daily[0]?.uncachedInputTokens).toBe(80);
    expect(tokens.daily[0]?.outputTokens).toBe(40);
    expect(tokens.currentHourTokens.totalTokens).toBe(140);
    expect(tokens.currentHourTokens.cachedInputTokens).toBe(20);
    expect(tokens.currentHourTokens.uncachedTokens).toBe(120);
    expect(tokens.hourly[0]?.totalTokens).toBe(140);
    expect(tokens.hourly[0]?.requestCount).toBe(1);
  });

  it("rollout 파일이 바뀌면 다음 동기화에서 다시 집계한다", () => {
    const fixture = createTestFixture();
    fixtures.push(fixture);

    const codex = new CodexDataService(fixture.config);
    const collector = new TokenCollectorService(fixture.config, codex);

    collector.captureSnapshot(new Date("2026-03-14T10:05:00+09:00"));

    fs.appendFileSync(
      fixture.rolloutPath,
      `\n${JSON.stringify({
        timestamp: "2026-03-14T11:00:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 240,
              cached_input_tokens: 20,
              output_tokens: 100,
              reasoning_output_tokens: 20,
              total_tokens: 340
            },
            last_token_usage: {
              input_tokens: 140,
              output_tokens: 60,
              reasoning_output_tokens: 10,
              total_tokens: 200
            }
          }
        }
      })}`,
      "utf8"
    );

    const staleTokens = collector.getTokens(1, new Date("2026-03-14T20:10:00+09:00"));
    expect(staleTokens.daily[0]?.totalTokens).toBe(140);

    collector.captureSnapshot(new Date("2026-03-14T20:10:00+09:00"));

    const tokens = collector.getTokens(1, new Date("2026-03-14T20:10:00+09:00"));
    expect(tokens.daily[0]?.totalTokens).toBe(340);
    expect(tokens.daily[0]?.inputTokens).toBe(240);
    expect(tokens.daily[0]?.cachedInputTokens).toBe(20);
    expect(tokens.daily[0]?.uncachedTokens).toBe(320);
    expect(tokens.daily[0]?.uncachedInputTokens).toBe(220);
    expect(tokens.daily[0]?.outputTokens).toBe(100);
    expect(tokens.currentHourTokens.totalTokens).toBe(200);
    expect(tokens.currentHourTokens.cachedInputTokens).toBe(0);
    expect(tokens.currentHourTokens.uncachedTokens).toBe(200);
    expect(tokens.hourly).toHaveLength(2);
    expect(tokens.hourly[1]?.totalTokens).toBe(200);
  });

  it("last_token_usage가 없는 오래된 이벤트는 total_token_usage 차이로 보정한다", () => {
    const fixture = createTestFixture();
    fixtures.push(fixture);

    const codex = new CodexDataService(fixture.config);
    const collector = new TokenCollectorService(fixture.config, codex);

    collector.captureSnapshot(new Date("2026-03-14T10:05:00+09:00"));

    fs.appendFileSync(
      fixture.rolloutPath,
      `\n${JSON.stringify({
        timestamp: "2026-03-14T12:00:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 200,
              cached_input_tokens: 20,
              output_tokens: 80,
              reasoning_output_tokens: 10,
              total_tokens: 300
            }
          }
        }
      })}`,
      "utf8"
    );

    collector.captureSnapshot(new Date("2026-03-14T21:10:00+09:00"));

    const tokens = collector.getTokens(1, new Date("2026-03-14T21:10:00+09:00"));
    expect(tokens.daily[0]?.totalTokens).toBe(300);
    expect(tokens.daily[0]?.inputTokens).toBe(200);
    expect(tokens.daily[0]?.cachedInputTokens).toBe(20);
    expect(tokens.daily[0]?.uncachedTokens).toBe(280);
    expect(tokens.daily[0]?.uncachedInputTokens).toBe(180);
    expect(tokens.daily[0]?.outputTokens).toBe(80);
    expect(tokens.currentHourTokens.totalTokens).toBe(160);
    expect(tokens.currentHourTokens.uncachedTokens).toBe(160);
    expect(tokens.hourly[1]?.totalTokens).toBe(160);
  });
});
