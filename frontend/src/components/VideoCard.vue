<template>
  <div class="video-card">
    <a :href="video.videoUrl" target="_blank" rel="noopener noreferrer" class="thumbnail-link">
      <img :src="video.thumbnail" :alt="video.title" class="thumbnail" loading="lazy" />
    </a>

    <div class="card-body">
      <h3 class="card-title">
        <a :href="video.videoUrl" target="_blank" rel="noopener noreferrer">
          {{ video.title }}
        </a>
      </h3>

      <div class="card-summary" :class="{ expanded }">
        <p>{{ video.summary }}</p>
      </div>

      <button v-if="isLongSummary" class="view-more-btn" @click="expanded = !expanded">
        {{ expanded ? 'Show Less' : 'View More' }}
      </button>

      <div class="card-meta">
        <span class="channel-name">{{ video.channel.channelName }}</span>
        <span class="posted-time">{{ timeAgo }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { formatDistanceToNow } from 'date-fns';

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

const props = defineProps<{ video: Video }>();

const expanded = ref(false);

const timeAgo = computed(() => {
  return formatDistanceToNow(new Date(props.video.publishedAt), { addSuffix: true });
});

const isLongSummary = computed(() => {
  return props.video.summary.length > 200;
});
</script>

<style scoped>
.video-card {
  background: var(--color-surface);
  border-radius: var(--radius);
  overflow: hidden;
  box-shadow: var(--shadow-sm);
  border: 1px solid var(--color-border);
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}

.video-card:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-lg);
}

.thumbnail-link {
  display: block;
}

.thumbnail {
  width: 100%;
  aspect-ratio: 16 / 9;
  object-fit: cover;
  display: block;
}

.card-body {
  padding: 1rem;
}

.card-title {
  font-size: 0.95rem;
  font-weight: 600;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  margin-bottom: 0.5rem;
}

.card-title a {
  color: var(--color-text);
}

.card-title a:hover {
  color: var(--color-primary);
}

.card-summary {
  font-size: 0.85rem;
  color: var(--color-text-secondary);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  margin-bottom: 0.5rem;
}

.card-summary.expanded {
  display: block;
  -webkit-line-clamp: unset;
}

.view-more-btn {
  background: none;
  color: var(--color-primary);
  font-size: 0.8rem;
  padding: 0;
  margin-bottom: 0.75rem;
}

.view-more-btn:hover {
  color: var(--color-primary-hover);
}

.card-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  border-top: 1px solid var(--color-border);
  padding-top: 0.75rem;
}

.channel-name {
  font-weight: 500;
}
</style>
