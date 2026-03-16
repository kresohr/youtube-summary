/**
 * Tests for the 429/403 error handling, Shorts filtering, and
 * cron retry logic introduced by the quota-retry feature.
 *
 * All external dependencies (DB, Gemini API, YouTube API) are mocked
 * so these tests run fast and offline.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── GeminiApiError ──────────────────────────────────────────────────────────

import { GeminiApiError } from "../jobs/geminiSummary.js";

describe("GeminiApiError", () => {
  it("stores the HTTP status code", () => {
    const err = new GeminiApiError(429, "quota exceeded");
    expect(err.status).toBe(429);
    expect(err.name).toBe("GeminiApiError");
    expect(err.message).toContain("HTTP 429");
    expect(err).toBeInstanceOf(Error);
  });

  it("truncates body to 400 chars", () => {
    const longBody = "x".repeat(1000);
    const err = new GeminiApiError(500, longBody);
    expect(err.message.length).toBeLessThan(500);
  });
});

// ─── parseIso8601Duration ────────────────────────────────────────────────────

import { parseIso8601Duration } from "../jobs/fetchVideos.js";

describe("parseIso8601Duration", () => {
  it("parses hours, minutes, seconds", () => {
    expect(parseIso8601Duration("PT1H2M3S")).toBe(3723);
  });
  it("parses minutes and seconds only", () => {
    expect(parseIso8601Duration("PT10M30S")).toBe(630);
  });
  it("parses seconds only", () => {
    expect(parseIso8601Duration("PT45S")).toBe(45);
  });
  it("returns 0 for unparseable input", () => {
    expect(parseIso8601Duration("invalid")).toBe(0);
  });
  it("identifies a Short (≤ 60s)", () => {
    expect(parseIso8601Duration("PT58S")).toBeLessThanOrEqual(60);
    expect(parseIso8601Duration("PT1M0S")).toBeLessThanOrEqual(60);
  });
  it("identifies a non-Short (> 60s)", () => {
    expect(parseIso8601Duration("PT1M1S")).toBeGreaterThan(60);
  });
});

// ─── getVideoSummaryForVideo: error propagation ─────────────────────────────

// We need to mock the summarizeVideo function to control what it throws.
vi.mock("../jobs/geminiSummary.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../jobs/geminiSummary.js")>();
  return {
    ...actual,
    // Will be controlled per-test via vi.mocked()
    summarizeVideo: vi.fn(),
  };
});

// Also mock the DB query to avoid real DB calls
vi.mock("../lib/db.js", () => ({
  query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
}));

import { getVideoSummaryForVideo } from "../jobs/fetchVideos.js";
import { summarizeVideo } from "../jobs/geminiSummary.js";

const mockedSummarize = vi.mocked(summarizeVideo);

describe("getVideoSummaryForVideo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns summary on success", async () => {
    mockedSummarize.mockResolvedValue("## 📝 Overview\nGreat video about testing.");
    const result = await getVideoSummaryForVideo("abc123", "Test", null);
    expect(result).toContain("Overview");
  });

  it("re-throws GeminiApiError with status 429", async () => {
    mockedSummarize.mockRejectedValue(new GeminiApiError(429, "quota exceeded"));
    await expect(
      getVideoSummaryForVideo("abc123", "Test", null)
    ).rejects.toThrow(GeminiApiError);

    try {
      await getVideoSummaryForVideo("abc123", "Test", null);
    } catch (err) {
      expect(err).toBeInstanceOf(GeminiApiError);
      expect((err as GeminiApiError).status).toBe(429);
    }
  });

  it("re-throws GeminiApiError with status 403", async () => {
    mockedSummarize.mockRejectedValue(
      new GeminiApiError(403, "permission denied")
    );
    await expect(
      getVideoSummaryForVideo("abc123", "Test", null)
    ).rejects.toThrow(GeminiApiError);

    try {
      await getVideoSummaryForVideo("abc123", "Test", null);
    } catch (err) {
      expect(err).toBeInstanceOf(GeminiApiError);
      expect((err as GeminiApiError).status).toBe(403);
    }
  });

  it("returns null for a generic Gemini error (e.g. 500)", async () => {
    mockedSummarize.mockRejectedValue(new GeminiApiError(500, "server error"));
    const result = await getVideoSummaryForVideo("abc123", "Test", null);
    expect(result).toBeNull();
  });

  it("returns null for non-Gemini errors (e.g. timeout)", async () => {
    mockedSummarize.mockRejectedValue(new Error("fetch timed out"));
    const result = await getVideoSummaryForVideo("abc123", "Test", null);
    expect(result).toBeNull();
  });
});

// ─── Shorts filtering logic (unit-level) ────────────────────────────────────

describe("Shorts filtering", () => {
  const SHORTS_MAX = 60;

  interface MockVideo {
    id: string;
    title: string;
    durationSeconds: number | null;
  }

  function filterShorts(videos: MockVideo[]): MockVideo[] {
    return videos.filter(
      (v) =>
        !(v.durationSeconds !== null && v.durationSeconds <= SHORTS_MAX)
    );
  }

  it("removes videos ≤ 60s", () => {
    const videos: MockVideo[] = [
      { id: "a", title: "Short clip", durationSeconds: 30 },
      { id: "b", title: "Normal video", durationSeconds: 600 },
      { id: "c", title: "Exactly 60s", durationSeconds: 60 },
      { id: "d", title: "61 seconds", durationSeconds: 61 },
    ];
    const filtered = filterShorts(videos);
    expect(filtered.map((v) => v.id)).toEqual(["b", "d"]);
  });

  it("keeps videos with unknown duration (null)", () => {
    const videos: MockVideo[] = [
      { id: "a", title: "Unknown duration", durationSeconds: null },
      { id: "b", title: "Long video", durationSeconds: 120 },
    ];
    const filtered = filterShorts(videos);
    expect(filtered).toHaveLength(2);
  });
});

// ─── Cron retry timing logic ────────────────────────────────────────────────

describe("Cron retry timing", () => {
  const CRON_HOUR = 5;
  const RETRY_DELAY_MS = 90 * 60 * 1000;

  /** Replica of nextCronRunTime() from cronManager.ts */
  function nextCronRunTime(now: Date): Date {
    const next = new Date(now);
    next.setUTCHours(CRON_HOUR, 0, 0, 0);
    if (next <= now) {
      next.setUTCDate(next.getUTCDate() + 1);
    }
    return next;
  }

  function shouldRetry(now: Date): boolean {
    const nextCron = nextCronRunTime(now).getTime();
    return now.getTime() + RETRY_DELAY_MS < nextCron;
  }

  it("retries at 06:00 UTC (next cron is tomorrow 05:00, plenty of room)", () => {
    const now = new Date("2026-03-16T06:00:00Z");
    expect(shouldRetry(now)).toBe(true);
  });

  it("retries at 10:00 UTC (next cron is tomorrow 05:00)", () => {
    const now = new Date("2026-03-16T10:00:00Z");
    expect(shouldRetry(now)).toBe(true);
  });

  it("does NOT retry at 03:30 UTC (next cron is 05:00, only 1.5h away)", () => {
    const now = new Date("2026-03-16T03:30:00Z");
    expect(shouldRetry(now)).toBe(false);
  });

  it("does NOT retry at 04:00 UTC (next cron is 05:00, only 1h away)", () => {
    const now = new Date("2026-03-16T04:00:00Z");
    expect(shouldRetry(now)).toBe(false);
  });

  it("retries at 02:00 UTC (next cron is 05:00, 3h away > 1.5h)", () => {
    const now = new Date("2026-03-16T02:00:00Z");
    expect(shouldRetry(now)).toBe(true);
  });

  it("retries right after cron at 05:01 UTC (next cron is tomorrow)", () => {
    const now = new Date("2026-03-16T05:01:00Z");
    expect(shouldRetry(now)).toBe(true);
  });

  it("does NOT retry at 03:31 UTC (03:31 + 1.5h = 05:01 >= 05:00 cron)", () => {
    const now = new Date("2026-03-16T03:31:00Z");
    // 03:31 + 90min = 05:01 which is >= 05:00 → should not retry
    expect(shouldRetry(now)).toBe(false);
  });

  it("retries at 03:29 UTC (03:29 + 90min = 04:59 < 05:00)", () => {
    const now = new Date("2026-03-16T03:29:00Z");
    expect(shouldRetry(now)).toBe(true);
  });
});
