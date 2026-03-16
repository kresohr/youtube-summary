import cron, { ScheduledTask } from "node-cron";
import { fetchAndSummarizeVideos } from "../jobs/fetchVideos.js";
import { GeminiApiError } from "../jobs/geminiSummary.js";

let task: ScheduledTask | null = null;
let active = true;

/** Cron runs daily at this hour (UTC). */
const CRON_HOUR = 5;

/** How long to wait (ms) before retrying after a 429 quota error. */
const RETRY_DELAY_MS = 90 * 60 * 1000; // 1.5 hours

/** Return the next occurrence of the daily cron time (today if not yet past, otherwise tomorrow). */
function nextCronRunTime(): Date {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(CRON_HOUR, 0, 0, 0);
  if (next <= now) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next;
}

/** Sleep for the given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run fetchAndSummarizeVideos with automatic 429-retry logic.
 *
 * If a GeminiApiError with status 429 is thrown, the function waits 1.5 hours
 * and retries — unless the retry would finish too close to the next daily cron
 * run (within the retry window).
 */
async function runWithQuotaRetry(category: string): Promise<void> {
  while (true) {
    try {
      await fetchAndSummarizeVideos(category);
      return; // Success — done
    } catch (error) {
      if (error instanceof GeminiApiError && error.status === 429) {
        const now = Date.now();
        const nextCron = nextCronRunTime().getTime();

        if (now + RETRY_DELAY_MS >= nextCron) {
          console.log(
            `[Cron] Gemini quota exceeded. Next retry would overlap with cron at ` +
              `${new Date(nextCron).toISOString()} — stopping retries.`
          );
          return;
        }

        console.log(
          `[Cron] Gemini quota exceeded. Retrying in 1.5 hours ` +
            `(at ~${new Date(now + RETRY_DELAY_MS).toISOString()})…`
        );
        await sleep(RETRY_DELAY_MS);
        // Loop back and retry
      } else {
        // Non-429 error — log and stop
        console.error(
          "[Cron] Fetch job failed:",
          error instanceof Error ? error.message : "Unknown error"
        );
        return;
      }
    }
  }
}

export function initCron(): void {
  task = cron.schedule("0 5 * * *", () => {
    if (!active) return;
    console.log(
      `[${new Date().toISOString()}] Cron triggered: daily video fetch`
    );
    runWithQuotaRetry("main").catch((error) => {
      console.error("Cron fetch error:", error);
    });
  });

  active = true;
  console.log(
    `[${new Date().toISOString()}] Cron job scheduled: daily at 05:00`
  );
}

export function getCronStatus(): { active: boolean } {
  return { active };
}

export function setCronStatus(enabled: boolean): void {
  if (!task) return;
  if (enabled) {
    task.start();
  } else {
    task.stop();
  }
  active = enabled;
  console.log(
    `[${new Date().toISOString()}] Cron job ${enabled ? "started" : "stopped"}`
  );
}
