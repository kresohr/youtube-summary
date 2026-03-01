import cron, { ScheduledTask } from "node-cron";
import { fetchAndSummarizeVideos } from "../jobs/fetchVideos.js";

let task: ScheduledTask | null = null;
let active = true;

export function initCron(): void {
  task = cron.schedule("0 5 * * *", () => {
    if (!active) return;
    console.log(
      `[${new Date().toISOString()}] Cron triggered: daily video fetch`
    );
    fetchAndSummarizeVideos().catch((error) => {
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
