-- Database initialization script
-- Tables are created automatically when the PostgreSQL container starts

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(255) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS youtube_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id VARCHAR(255) UNIQUE NOT NULL,
  channel_name VARCHAR(255) NOT NULL,
  channel_url VARCHAR(512) NOT NULL,
  category VARCHAR(50) NOT NULL DEFAULT 'main',
  added_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Migrate existing channels: add category column if it doesn't exist yet
ALTER TABLE youtube_channels ADD COLUMN IF NOT EXISTS category VARCHAR(50) NOT NULL DEFAULT 'main';

CREATE TABLE IF NOT EXISTS videos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id VARCHAR(255) UNIQUE NOT NULL,
  title VARCHAR(512) NOT NULL,
  thumbnail VARCHAR(512) NOT NULL,
  summary TEXT NOT NULL,
  video_url VARCHAR(512) NOT NULL,
  published_at TIMESTAMP NOT NULL,
  fetched_at TIMESTAMP NOT NULL DEFAULT NOW(),
  channel_id UUID NOT NULL REFERENCES youtube_channels(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_videos_published_at ON videos(published_at);
CREATE INDEX IF NOT EXISTS idx_videos_channel_id ON videos(channel_id);
