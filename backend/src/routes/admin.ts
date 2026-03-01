import { Router, Request, Response } from "express";
import { authMiddleware } from "../middleware/auth.js";
import { fetchAndSummarizeVideos } from "../jobs/fetchVideos.js";
import { getCronStatus, setCronStatus } from "../lib/cronManager.js";
import {
  startSingleVideoJob,
  getJobStatus,
  MANUAL_CHANNEL_ID,
} from "../jobs/fetchSingleVideo.js";
import { query } from "../lib/db.js";

const router = Router();

// POST /api/admin/trigger-fetch - Manually trigger video fetch for 'main' channels (protected)
router.post(
  "/trigger-fetch",
  authMiddleware,
  async (_req: Request, res: Response): Promise<void> => {
    try {
      res.json({
        message:
          "Video fetch job triggered for main channels. Processing in background.",
      });

      // Run the job in the background (don't await) — only 'main' channels
      fetchAndSummarizeVideos("main").catch((error) => {
        console.error(
          "Manual trigger error:",
          error instanceof Error ? error.message : "Unknown error"
        );
      });
    } catch (error) {
      console.error(
        "Error triggering fetch:",
        error instanceof Error ? error.message : "Unknown error"
      );
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// POST /api/admin/fetch-category - Manually trigger video fetch for a specific non-main category (protected)
router.post(
  "/fetch-category",
  authMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { category } = req.body;

      if (typeof category !== "string") {
        res.status(400).json({ error: "category is required" });
        return;
      }

      const normalizedCategory = category.trim().toLowerCase();

      if (!normalizedCategory) {
        res.status(400).json({ error: "category is required" });
        return;
      }

      if (normalizedCategory.length > 50) {
        res.status(400).json({ error: "category exceeds maximum length" });
        return;
      }

      if (normalizedCategory === "main") {
        res
          .status(400)
          .json({ error: "Use /trigger-fetch to fetch main channels" });
        return;
      }

      res.json({
        message: `Video fetch job triggered for "${normalizedCategory}" channels. Processing in background.`,
      });

      // Run the job in the background (don't await)
      fetchAndSummarizeVideos(normalizedCategory).catch((error) => {
        console.error(
          `Fetch-category trigger error (${normalizedCategory}):`,
          error instanceof Error ? error.message : "Unknown error"
        );
      });
    } catch (error) {
      console.error(
        "Error triggering category fetch:",
        error instanceof Error ? error.message : "Unknown error"
      );
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// GET /api/admin/cron-status - Get current cron job status (protected)
router.get(
  "/cron-status",
  authMiddleware,
  (_req: Request, res: Response): void => {
    res.json(getCronStatus());
  }
);

// POST /api/admin/cron-status - Enable or disable the daily cron job (protected)
router.post(
  "/cron-status",
  authMiddleware,
  (req: Request, res: Response): void => {
    const { active } = req.body;

    if (typeof active !== "boolean") {
      res.status(400).json({ error: '"active" must be a boolean' });
      return;
    }

    setCronStatus(active);
    res.json(getCronStatus());
  }
);

// POST /api/admin/fetch-single-video - Start a single-video fetch job (protected)
router.post(
  "/fetch-single-video",
  authMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { videoUrl } = req.body;

      if (typeof videoUrl !== "string" || !videoUrl.trim()) {
        res.status(400).json({ error: "videoUrl is required" });
        return;
      }

      const { jobId, error } = startSingleVideoJob(videoUrl.trim());

      if (error) {
        res.status(400).json({ error });
        return;
      }

      res.status(202).json({ jobId });
    } catch (error) {
      console.error(
        "Error starting single video fetch:",
        error instanceof Error ? error.message : "Unknown error"
      );
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// GET /api/admin/fetch-single-video/:jobId - Poll single-video job status (protected)
router.get(
  "/fetch-single-video/:jobId",
  authMiddleware,
  (_req: Request, res: Response): void => {
    const jobId = _req.params.jobId as string;
    const job = getJobStatus(jobId);

    if (!job) {
      res.status(404).json({ error: "Job not found or expired" });
      return;
    }

    res.json(job);
  }
);

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/admin/standalone-videos - List all manually-fetched videos (protected)
router.get(
  "/standalone-videos",
  authMiddleware,
  async (_req: Request, res: Response): Promise<void> => {
    try {
      const result = await query(
        `SELECT id, video_id, title, thumbnail, video_url, published_at, fetched_at, duration_seconds, summary
         FROM videos
         WHERE channel_id = $1
         ORDER BY fetched_at DESC`,
        [MANUAL_CHANNEL_ID]
      );

      const videos = result.rows.map((row) => ({
        id: row.id,
        videoId: row.video_id,
        title: row.title,
        thumbnail: row.thumbnail,
        videoUrl: row.video_url,
        publishedAt: row.published_at,
        fetchedAt: row.fetched_at,
        durationSeconds: row.duration_seconds ?? null,
        summary: row.summary,
      }));

      res.json(videos);
    } catch (error) {
      console.error(
        "Error fetching standalone videos:",
        error instanceof Error ? error.message : "Unknown error"
      );
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// DELETE /api/admin/videos/:id - Delete a standalone video (protected)
router.delete(
  "/videos/:id",
  authMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const id = req.params.id as string;

      if (!UUID_REGEX.test(id)) {
        res.status(400).json({ error: "Invalid video ID format" });
        return;
      }

      // Only allow deletion of standalone (manual) videos
      const result = await query(
        "DELETE FROM videos WHERE id = $1 AND channel_id = $2 RETURNING id",
        [id, MANUAL_CHANNEL_ID]
      );

      if (result.rows.length === 0) {
        res.status(404).json({
          error:
            "Video not found or is not a standalone video. Only manually-fetched videos can be deleted here.",
        });
        return;
      }

      res.status(204).send();
    } catch (error) {
      console.error(
        "Error deleting video:",
        error instanceof Error ? error.message : "Unknown error"
      );
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

export default router;
