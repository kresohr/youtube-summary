<template>
  <div class="summary-page">
    <header class="page-header">
      <div class="container">
        <h1>📺 YouTube Video Summaries</h1>
        <p class="subtitle">AI-powered summaries of the latest videos</p>
      </div>
    </header>

    <main class="container">
      <!-- Filters -->
      <div class="filters">
        <select v-model="selectedChannel" @change="fetchVideos">
          <option value="">All Channels</option>
          <option v-for="ch in channels" :key="ch.id" :value="ch.id">
            {{ ch.channelName }}
          </option>
        </select>
      </div>

      <!-- Loading State -->
      <div v-if="loading" class="loading">
        <div class="spinner"></div>
        <p>Loading summaries...</p>
      </div>

      <!-- Empty State -->
      <div v-else-if="videos.length === 0" class="empty-state">
        <p>📭 No videos summarized yet</p>
        <p class="empty-hint">Videos will appear here once channels are configured and the system fetches new content.</p>
      </div>

      <!-- Video Grid -->
      <div v-else class="video-grid">
        <VideoCard
          v-for="video in videos"
          :key="video.id"
          :video="video"
        />
      </div>

      <!-- Load More -->
      <div v-if="hasMore && !loading" class="load-more">
        <button class="btn-outline" @click="loadMore">Load More</button>
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import api from '../api';
import VideoCard from '../components/VideoCard.vue';

interface Channel {
  id: string;
  channelName: string;
}

interface Video {
  id: string;
  videoId: string;
  title: string;
  thumbnail: string;
  summary: string;
  videoUrl: string;
  publishedAt: string;
  channel: {
    channelName: string;
    channelUrl: string;
  };
}

const videos = ref<Video[]>([]);
const channels = ref<Channel[]>([]);
const loading = ref(true);
const hasMore = ref(false);
const selectedChannel = ref('');
const offset = ref(0);
const limit = 12;

async function fetchVideos() {
  loading.value = true;
  offset.value = 0;
  try {
    const params: Record<string, string | number> = { limit, offset: 0 };
    if (selectedChannel.value) params.channelId = selectedChannel.value;

    const { data } = await api.get('/videos', { params });
    videos.value = data.videos;
    hasMore.value = data.hasMore;
    offset.value = limit;
  } catch (error) {
    console.error('Error fetching videos:', error);
  } finally {
    loading.value = false;
  }
}

async function loadMore() {
  try {
    const params: Record<string, string | number> = { limit, offset: offset.value };
    if (selectedChannel.value) params.channelId = selectedChannel.value;

    const { data } = await api.get('/videos', { params });
    videos.value.push(...data.videos);
    hasMore.value = data.hasMore;
    offset.value += limit;
  } catch (error) {
    console.error('Error loading more videos:', error);
  }
}

async function fetchChannels() {
  try {
    // Channels list is public for the filter dropdown
    const { data } = await api.get('/videos', { params: { limit: 1000 } });
    const uniqueChannels = new Map<string, Channel>();
    for (const v of data.videos) {
      if (!uniqueChannels.has(v.channelId)) {
        uniqueChannels.set(v.channelId, {
          id: v.channelId,
          channelName: v.channel.channelName,
        });
      }
    }
    channels.value = Array.from(uniqueChannels.values());
  } catch {
    // Channels filter is optional, don't fail
  }
}

onMounted(() => {
  fetchVideos();
  fetchChannels();
});
</script>

<style scoped>
.summary-page {
  min-height: 100vh;
}

.page-header {
  background: linear-gradient(135deg, #1e293b 0%, #334155 100%);
  color: white;
  padding: 2rem 0;
  margin-bottom: 2rem;
}

.page-header h1 {
  font-size: 1.75rem;
  margin-bottom: 0.25rem;
}

.subtitle {
  color: #94a3b8;
  font-size: 0.95rem;
}

.filters {
  margin-bottom: 1.5rem;
  max-width: 250px;
}

.filters select {
  background: white;
}

.video-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1.5rem;
}

@media (max-width: 1024px) {
  .video-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 640px) {
  .video-grid {
    grid-template-columns: 1fr;
  }
}

.loading {
  text-align: center;
  padding: 3rem 0;
  color: var(--color-text-secondary);
}

.spinner {
  width: 40px;
  height: 40px;
  border: 3px solid var(--color-border);
  border-top-color: var(--color-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  margin: 0 auto 1rem;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.empty-state {
  text-align: center;
  padding: 4rem 1rem;
  color: var(--color-text-secondary);
}

.empty-state p:first-child {
  font-size: 1.5rem;
  margin-bottom: 0.5rem;
}

.empty-hint {
  font-size: 0.875rem;
}

.load-more {
  text-align: center;
  padding: 2rem 0;
}

.load-more button {
  padding: 0.625rem 2rem;
}
</style>
