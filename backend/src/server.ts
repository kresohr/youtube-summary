import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";

import { noIndexMiddleware } from "./middleware/noIndex.js";
import authRoutes from "./routes/auth.js";
import channelRoutes from "./routes/channels.js";
import videoRoutes from "./routes/videos.js";
import adminRoutes from "./routes/admin.js";
import { fetchAndSummarizeVideos } from "./jobs/fetchVideos.js";
import { initCron } from "./lib/cronManager.js";

// Fail fast if critical env vars are missing
if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET environment variable is not set");
}

const app = express();
const PORT = process.env.PORT || 4000;

// Trust first proxy (nginx) so X-Forwarded-For is used for client IP
app.set("trust proxy", 1);

// Security middleware
app.use(helmet());
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "http://localhost:8080",
    methods: ["GET", "POST", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(express.json({ limit: "1mb" }));

// Disable x-powered-by (defense in depth, helmet also handles this)
app.disable("x-powered-by");

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

  // Initialize scheduled cron job
  initCron();
});
