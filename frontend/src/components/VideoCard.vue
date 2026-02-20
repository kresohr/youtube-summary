<template>
  <div class="video-card">
    <a
      :href="video.videoUrl"
      target="_blank"
      rel="noopener noreferrer"
      class="thumbnail-link"
    >
      <img
        :src="video.thumbnail"
        :alt="video.title"
        class="thumbnail"
        loading="lazy"
      />
    </a>

    <div class="card-body">
      <h3 class="card-title">
        <a :href="video.videoUrl" target="_blank" rel="noopener noreferrer">
          {{ video.title }}
        </a>
      </h3>

      <div class="card-summary">
        <p>{{ summaryPreview }}</p>
      </div>

      <button
        v-if="isLongSummary"
        class="view-more-btn"
        @click="showDialog = true"
      >
        View More
      </button>

      <div class="card-meta">
        <span class="channel-name">{{ video.channel.channelName }}</span>
        <span class="posted-time">{{ timeAgo }}</span>
      </div>
    </div>

    <!-- Full Summary Dialog -->
    <Teleport to="body">
      <Transition name="dialog">
        <div
          v-if="showDialog"
          class="dialog-overlay"
          @click="showDialog = false"
        >
          <div class="dialog-content" @click.stop>
            <div class="dialog-header">
              <h2>{{ video.title }}</h2>
              <button
                class="close-btn"
                @click="showDialog = false"
                aria-label="Close"
              >
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div class="dialog-body">
              <MarkdownRenderer :source="video.summary" />
            </div>
            <div class="dialog-footer">
              <a
                :href="video.videoUrl"
                target="_blank"
                rel="noopener noreferrer"
                class="watch-btn"
              >
                Watch Video
              </a>
              <button class="close-footer-btn" @click="showDialog = false">
                Close
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
  import { ref, computed } from "vue";
  import { formatDistanceToNow } from "date-fns";
  import MarkdownRenderer from "./MarkdownRenderer.vue";

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

  const showDialog = ref(false);

  const timeAgo = computed(() => {
    return formatDistanceToNow(new Date(props.video.publishedAt), {
      addSuffix: true,
    });
  });

  const isLongSummary = computed(() => {
    return props.video.summary.length > 200;
  });

  /** Strip markdown syntax for the plain-text card preview */
  function stripMarkdown(text: string): string {
    return text
      .replace(/^#{1,6}\s+/gm, "") // headings
      .replace(/[*_~`]/g, "") // bold, italic, code, strikethrough
      .replace(/^\s*[-*+]\s+/gm, "") // unordered list bullets
      .replace(/^\s*\d+\.\s+/gm, "") // ordered list numbers
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links → label only
      .replace(/\n{2,}/g, " ") // collapse blank lines
      .replace(/\n/g, " ") // collapse newlines
      .trim();
  }

  /** Plain-text snippet shown on the card (max ~200 chars) */
  const summaryPreview = computed(() => {
    const plain = stripMarkdown(props.video.summary);
    return plain.length > 200 ? plain.substring(0, 200) + "…" : plain;
  });
</script>

<style scoped>
  .video-card {
    background: var(--color-surface);
    border-radius: var(--radius);
    overflow: hidden;
    box-shadow: var(--shadow-sm);
    border: 1px solid var(--color-border);
    transition:
      transform 0.2s ease,
      box-shadow 0.2s ease;
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
    line-clamp: 2;
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
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    margin-bottom: 0.5rem;
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

  /* Dialog Styles */
  .dialog-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 1rem;
    backdrop-filter: blur(4px);
  }

  .dialog-content {
    background: var(--color-surface);
    border-radius: var(--radius-lg, 12px);
    max-width: 700px;
    width: 100%;
    max-height: 85vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
    border: 1px solid var(--color-border);
  }

  .dialog-header {
    padding: 1.5rem;
    border-bottom: 1px solid var(--color-border);
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
  }

  .dialog-header h2 {
    font-size: 1.25rem;
    font-weight: 600;
    line-height: 1.4;
    margin: 0;
    color: var(--color-text);
  }

  .close-btn {
    background: none;
    border: none;
    padding: 0.25rem;
    cursor: pointer;
    color: var(--color-text-secondary);
    flex-shrink: 0;
    border-radius: 4px;
    transition: all 0.2s ease;
  }

  .close-btn:hover {
    color: var(--color-text);
    background: var(--color-border);
  }

  .dialog-body {
    padding: 1.5rem;
    overflow-y: auto;
    flex: 1;
  }

  .dialog-footer {
    padding: 1rem 1.5rem;
    border-top: 1px solid var(--color-border);
    display: flex;
    gap: 0.75rem;
    justify-content: flex-end;
  }

  .watch-btn {
    background: var(--color-primary);
    color: white;
    padding: 0.5rem 1.25rem;
    border-radius: var(--radius);
    text-decoration: none;
    font-weight: 500;
    font-size: 0.9rem;
    transition: background 0.2s ease;
  }

  .watch-btn:hover {
    background: var(--color-primary-hover);
  }

  .close-footer-btn {
    background: transparent;
    color: var(--color-text-secondary);
    border: 1px solid var(--color-border);
    padding: 0.5rem 1.25rem;
    border-radius: var(--radius);
    font-weight: 500;
    font-size: 0.9rem;
  }

  .close-footer-btn:hover {
    background: var(--color-border);
    color: var(--color-text);
  }

  /* Dialog Transitions */
  .dialog-enter-active,
  .dialog-leave-active {
    transition: opacity 0.3s ease;
  }

  .dialog-enter-active .dialog-content,
  .dialog-leave-active .dialog-content {
    transition:
      transform 0.3s ease,
      opacity 0.3s ease;
  }

  .dialog-enter-from,
  .dialog-leave-to {
    opacity: 0;
  }

  .dialog-enter-from .dialog-content,
  .dialog-leave-to .dialog-content {
    transform: scale(0.95);
    opacity: 0;
  }
</style>
