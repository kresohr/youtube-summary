import { Router, Request, Response } from "express";
import { authMiddleware } from "../middleware/auth.js";
import { query } from "../lib/db.js";

const router = Router();
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/channels - Fetch all channels (protected)
router.get(
  "/",
  authMiddleware,
  async (_req: Request, res: Response): Promise<void> => {
    try {
      const result = await query(
        `SELECT c.*,
              (SELECT COUNT(*) FROM videos v WHERE v.channel_id = c.id) AS video_count
       FROM youtube_channels c
       ORDER BY c.added_at DESC`
      );

      const channels = result.rows.map((row) => ({
        id: row.id,
        channelId: row.channel_id,
        channelName: row.channel_name,
        channelUrl: row.channel_url,
        addedAt: row.added_at,
        _count: { videos: parseInt(row.video_count, 10) },
      }));

      res.json(channels);
    } catch (error) {
      console.error("Error fetching channels:", error instanceof Error ? error.message : "Unknown error");
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// POST /api/channels - Add a new channel (protected)
router.post(
  "/",
  authMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { channelId, channelName, channelUrl } = req.body;

      if (!channelId || !channelName) {
        res
          .status(400)
          .json({ error: "channelId and channelName are required" });
        return;
      }

      if (typeof channelId !== "string" || typeof channelName !== "string") {
        res.status(400).json({ error: "Invalid input types" });
        return;
      }

      // Validate input lengths
      if (channelId.length > 255 || channelName.length > 255) {
        res.status(400).json({ error: "Input exceeds maximum length" });
        return;
      }

      // Check if channel already exists
      const existing = await query(
        "SELECT id FROM youtube_channels WHERE channel_id = $1",
        [channelId]
      );

      if (existing.rows.length > 0) {
        res.status(409).json({ error: "Channel already exists" });
        return;
      }

      // Optionally validate channel exists via YouTube API
      if (process.env.YOUTUBE_API_KEY) {
        try {
          const url = new URL("https://www.googleapis.com/youtube/v3/channels");
          url.searchParams.set("part", "snippet");
          url.searchParams.set("id", channelId);
          url.searchParams.set("key", process.env.YOUTUBE_API_KEY);

          const ytResponse = await fetch(url.toString());

          // If YouTube API returned a non-2xx status, handle that explicitly
          if (!ytResponse.ok) {
            console.warn(
              `YouTube API returned non-OK status ${ytResponse.status}`
            );
            res
              .status(502)
              .json({ error: "YouTube API validation failed" });
            return;
          }

          const ytData = await ytResponse.json();

          if (!ytData.items || ytData.items.length === 0) {
            res.status(404).json({ error: "YouTube channel not found" });
            return;
          }
        } catch (ytError) {
          console.warn(
            "YouTube API validation failed, proceeding anyway:",
            ytError
          );
        }
      }

      const result = await query(
        `INSERT INTO youtube_channels (id, channel_id, channel_name, channel_url, added_at)
       VALUES (gen_random_uuid(), $1, $2, $3, NOW())
       RETURNING *`,
        [
          channelId,
          channelName,
          channelUrl || `https://www.youtube.com/channel/${channelId}`,
        ]
      );

      const row = result.rows[0];
      res.status(201).json({
        id: row.id,
        channelId: row.channel_id,
        channelName: row.channel_name,
        channelUrl: row.channel_url,
        addedAt: row.added_at,
      });
    } catch (error) {
      console.error("Error adding channel:", error instanceof Error ? error.message : "Unknown error");
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// DELETE /api/channels/:id - Delete a channel (protected)
router.delete(
  "/:id",
  authMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const id = req.params.id as string;

      if (!UUID_REGEX.test(id)) {
        res.status(400).json({ error: "Invalid channel ID format" });
        return;
      }

      const existing = await query(
        "SELECT id FROM youtube_channels WHERE id = $1",
        [id]
      );

      if (existing.rows.length === 0) {
        res.status(404).json({ error: "Channel not found" });
        return;
      }

      await query("DELETE FROM youtube_channels WHERE id = $1", [id]);

      res.json({ message: "Channel deleted successfully" });
    } catch (error) {
      console.error("Error deleting channel:", error instanceof Error ? error.message : "Unknown error");
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

export default router;
