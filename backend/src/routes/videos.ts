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
    const categoryInput = req.query.category as string | undefined;
    const category = typeof categoryInput === "string" ? categoryInput.trim().toLowerCase() : "";

    // Validate channelId format if provided
    if (channelId && !UUID_REGEX.test(channelId)) {
      res.status(400).json({ error: "Invalid channelId format" });
      return;
    }

    if (categoryInput !== undefined && !category) {
      res.status(400).json({ error: "category must be a non-empty string" });
      return;
    }

    if (category.length > 50) {
      res.status(400).json({ error: "category exceeds maximum length" });
      return;
    }

    const conditions: string[] = [];
    const filterParams: unknown[] = [];

    if (channelId) {
      filterParams.push(channelId);
      conditions.push(`v.channel_id = $${filterParams.length}`);
    }

    if (category) {
      filterParams.push(category);
      conditions.push(`LOWER(c.category) = $${filterParams.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const videosQuery = `
      SELECT v.*, c.channel_name, c.channel_url, c.category AS channel_category
      FROM videos v
      JOIN youtube_channels c ON v.channel_id = c.id
      ${whereClause}
      ORDER BY v.published_at DESC
      LIMIT $${filterParams.length + 1} OFFSET $${filterParams.length + 2}`;
    const countQuery = `
      SELECT COUNT(*)
      FROM videos v
      JOIN youtube_channels c ON v.channel_id = c.id
      ${whereClause}`;
    const videoParams = [...filterParams, limit, offset];

    const [videosResult, countResult] = await Promise.all([
      query(videosQuery, videoParams),
      query(countQuery, filterParams),
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
      category: row.channel_category,
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
      `SELECT v.*, c.channel_name, c.channel_url, c.category AS channel_category
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
      category: row.channel_category,
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
