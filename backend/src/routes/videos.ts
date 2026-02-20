import { Router, Request, Response } from "express";
import { query } from "../lib/db.js";

const router = Router();

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LIMIT = 100;

// GET /api/videos - Fetch all summarized videos (public)
router.get("/", async (req: Request, res: Response): Promise<void> => {
  try {
    const rawLimit = parseInt(req.query.limit as string) || 50;
    const limit = Math.min(Math.max(rawLimit, 1), MAX_LIMIT);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
    const channelId = req.query.channelId as string | undefined;

    // Validate channelId format if provided
    if (channelId && !UUID_REGEX.test(channelId)) {
      res.status(400).json({ error: "Invalid channelId format" });
      return;
    }

    let videosQuery: string;
    let countQuery: string;
    let params: unknown[];

    if (channelId) {
      videosQuery = `
        SELECT v.*, c.channel_name, c.channel_url
        FROM videos v
        JOIN youtube_channels c ON v.channel_id = c.id
        WHERE v.channel_id = $1
        ORDER BY v.published_at DESC
        LIMIT $2 OFFSET $3`;
      countQuery = "SELECT COUNT(*) FROM videos WHERE channel_id = $1";
      params = [channelId, limit, offset];
    } else {
      videosQuery = `
        SELECT v.*, c.channel_name, c.channel_url
        FROM videos v
        JOIN youtube_channels c ON v.channel_id = c.id
        ORDER BY v.published_at DESC
        LIMIT $1 OFFSET $2`;
      countQuery = "SELECT COUNT(*) FROM videos";
      params = [limit, offset];
    }

    const [videosResult, countResult] = await Promise.all([
      query(videosQuery, params),
      query(countQuery, channelId ? [channelId] : []),
    ]);

    const total = parseInt(countResult.rows[0].count, 10);

    const videos = videosResult.rows.map((row) => ({
      id: row.id,
      videoId: row.video_id,
      title: row.title,
      thumbnail: row.thumbnail,
      summary: row.summary,
      videoUrl: row.video_url,
      publishedAt: row.published_at,
      fetchedAt: row.fetched_at,
      channelId: row.channel_id,
      channel: {
        channelName: row.channel_name,
        channelUrl: row.channel_url,
      },
    }));

    res.json({
      videos,
      total,
      hasMore: offset + limit < total,
    });
  } catch (error) {
    console.error("Error fetching videos:", error instanceof Error ? error.message : "Unknown error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/videos/:id - Fetch single video (public)
router.get("/:id", async (req: Request, res: Response): Promise<void> => {
  try {
    const id = req.params.id as string;

    if (!UUID_REGEX.test(id)) {
      res.status(400).json({ error: "Invalid video ID format" });
      return;
    }

    const result = await query(
      `SELECT v.*, c.channel_name, c.channel_url
       FROM videos v
       JOIN youtube_channels c ON v.channel_id = c.id
       WHERE v.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: "Video not found" });
      return;
    }

    const row = result.rows[0];
    const video = {
      id: row.id,
      videoId: row.video_id,
      title: row.title,
      thumbnail: row.thumbnail,
      summary: row.summary,
      videoUrl: row.video_url,
      publishedAt: row.published_at,
      fetchedAt: row.fetched_at,
      channelId: row.channel_id,
      channel: {
        channelName: row.channel_name,
        channelUrl: row.channel_url,
      },
    };

    res.json(video);
  } catch (error) {
    console.error("Error fetching video:", error instanceof Error ? error.message : "Unknown error");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
