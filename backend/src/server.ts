import "dotenv/config";
import express from "express";
import cors from "cors";
import cron from "node-cron";

import { noIndexMiddleware } from "./middleware/noIndex.js";
import authRoutes from "./routes/auth.js";
import channelRoutes from "./routes/channels.js";
import videoRoutes from "./routes/videos.js";
import adminRoutes from "./routes/admin.js";
import { fetchAndSummarizeVideos } from "./jobs/fetchVideos.js";

const app = express();
const PORT = process.env.PORT || 4000;

// Middleware
app.use(cors());
app.use(express.json());

// Apply noindex header to all API routes
app.use("/api", noIndexMiddleware);

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/channels", channelRoutes);
app.use("/api/videos", videoRoutes);
app.use("/api/admin", adminRoutes);

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] Server running on port ${PORT}`);

  // Run cron job once on startup
  console.log(
    `[${new Date().toISOString()}] Running initial video fetch on startup...`
  );
  fetchAndSummarizeVideos().catch((error) => {
    console.error("Startup fetch error:", error);
  });

  // Schedule daily at 05:00
  cron.schedule("0 5 * * *", () => {
    console.log(
      `[${new Date().toISOString()}] Cron triggered: daily video fetch`
    );
    fetchAndSummarizeVideos().catch((error) => {
      console.error("Cron fetch error:", error);
    });
  });

  console.log(
    `[${new Date().toISOString()}] Cron job scheduled: daily at 05:00`
  );
});
