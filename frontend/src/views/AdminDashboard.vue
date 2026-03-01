<template>
  <div class="admin-page">
    <header class="admin-header">
      <div class="container header-content">
        <h1>⚙️ Admin Dashboard</h1>
        <button class="btn-outline logout-btn" @click="logout">Logout</button>
      </div>
    </header>

    <main class="container">
      <!-- Add Channel Section -->
      <section class="admin-section">
        <h2>Add YouTube Channel</h2>
        <form @submit.prevent="addChannel" class="add-channel-form">
          <div class="form-row">
            <div class="form-group">
              <label for="channelUrl">YouTube Channel URL</label>

              <input
                id="channelUrl"
                v-model="newChannel.channelUrl"
                placeholder="https://youtube.com/@channel or https://youtube.com/channel/UCxxxxxx"
                required
              />
            </div>
            <div class="form-group">
              <label for="channelName"
                >Channel Name
                <span class="label-hint"
                  >(optional — auto-detected)</span
                ></label
              >
              <input
                id="channelName"
                v-model="newChannel.channelName"
                placeholder="e.g. Tech Channel"
              />
            </div>
            <div class="form-group">
              <label for="channelCategory">Category</label>
              <input
                id="channelCategory"
                v-model="newChannel.category"
                list="available-categories"
                placeholder="Select or type category"
                required
              />
              <datalist id="available-categories">
                <option
                  v-for="category in availableCategories"
                  :key="`add-${category}`"
                  :value="category"
                />
              </datalist>
            </div>
          </div>
          <button type="submit" class="btn-primary" :disabled="addingChannel">
            {{ addingChannel ? "Adding..." : "Add Channel" }}
          </button>
        </form>
      </section>

      <!-- Channels List -->
      <section class="admin-section">
        <div class="section-header">
          <h2>Configured Channels</h2>
          <div class="fetch-actions">
            <button
              class="btn-primary"
              @click="triggerFetch"
              :disabled="triggering"
            >
              {{ triggering ? "Triggering..." : "🔄 Fetch Main" }}
            </button>
            <div class="fetch-category-group">
              <input
                v-model="selectedFetchCategory"
                list="fetch-categories"
                placeholder="Select or type category"
              />
              <datalist id="fetch-categories">
                <option
                  v-for="category in availableCategories"
                  :key="`fetch-${category}`"
                  :value="category"
                />
              </datalist>
              <button
                class="btn-secondary"
                @click="triggerFetchByCategory"
                :disabled="triggeringCategory || !selectedFetchCategory"
              >
                {{ triggeringCategory ? "Triggering..." : "🎬 Fetch Category" }}
              </button>
            </div>
            <button
              class="toggle-btn"
              :class="cronActive ? 'active' : 'inactive'"
              @click="toggleCron"
              :disabled="togglingCron"
            >
              <span class="toggle-dot"></span>
              {{
                togglingCron
                  ? "..."
                  : cronActive
                    ? "Fetching Active"
                    : "Fetching Off"
              }}
            </button>
          </div>
        </div>

        <div class="table-filters" v-if="channels.length > 0">
          <label for="dashboardCategoryFilter">Filter by category</label>
          <select
            id="dashboardCategoryFilter"
            v-model="dashboardCategoryFilter"
          >
            <option value="">All categories</option>
            <option
              v-for="category in availableCategories"
              :key="`filter-${category}`"
              :value="category"
            >
              {{ category }}
            </option>
          </select>
        </div>

        <div v-if="loadingChannels" class="loading">
          <div class="spinner"></div>
          <p>Loading channels...</p>
        </div>

        <div v-else-if="channels.length === 0" class="empty-state">
          <p>No channels configured yet.</p>
        </div>

        <table v-else class="channels-table">
          <thead>
            <tr>
              <th>Channel Name</th>
              <th>Category</th>
              <th>Videos</th>
              <th>Added</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="filteredChannels.length === 0">
              <td colspan="5">No channels match the selected category.</td>
            </tr>
            <tr v-for="channel in filteredChannels" :key="channel.id">
              <td>
                <a
                  :href="channel.channelUrl"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {{ channel.channelName }}
                </a>
              </td>
              <td>
                <span
                  class="category-badge"
                  :class="`category-${channel.category ?? 'main'}`"
                >
                  {{ channel.category ?? "main" }}
                </span>
              </td>
              <td>{{ channel._count?.videos ?? 0 }}</td>
              <td>{{ formatDate(channel.addedAt) }}</td>
              <td>
                <button
                  class="btn-danger btn-sm"
                  @click="deleteChannel(channel)"
                >
                  Delete
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- Toast Notifications -->
      <div v-if="toast.show" class="toast" :class="toast.type">
        {{ toast.message }}
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
  import { ref, reactive, computed, onMounted } from "vue";
  import { useRouter } from "vue-router";
  import api from "../api";

  interface Channel {
    id: string;
    channelId: string;
    channelName: string;
    channelUrl: string;
    category: string;
    addedAt: string;
    _count?: { videos: number };
  }

  const router = useRouter();

  const channels = ref<Channel[]>([]);
  const loadingChannels = ref(true);
  const addingChannel = ref(false);
  const triggering = ref(false);
  const triggeringCategory = ref(false);
  const selectedFetchCategory = ref("");
  const dashboardCategoryFilter = ref("");
  const cronActive = ref(true);
  const togglingCron = ref(false);

  const newChannel = reactive({
    channelUrl: "",
    channelName: "",
    category: "",
  });

  const availableCategories = computed(() => {
    const categories = channels.value
      .map((channel) => (channel.category || "").trim().toLowerCase())
      .filter((category) => category.length > 0);

    categories.push("main", "entertainment");
    return [...new Set(categories)].sort((first, second) =>
      first.localeCompare(second)
    );
  });

  const filteredChannels = computed(() => {
    if (!dashboardCategoryFilter.value) {
      return channels.value;
    }

    return channels.value.filter(
      (channel) =>
        (channel.category || "").trim().toLowerCase() ===
        dashboardCategoryFilter.value
    );
  });

  const toast = reactive({
    show: false,
    message: "",
    type: "success" as "success" | "error",
  });

  function showToast(message: string, type: "success" | "error" = "success") {
    toast.show = true;
    toast.message = message;
    toast.type = type;
    setTimeout(() => {
      toast.show = false;
    }, 3000);
  }

  function formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  async function fetchChannels() {
    loadingChannels.value = true;
    try {
      const { data } = await api.get("/channels");
      channels.value = data;
    } catch (error) {
      console.error("Error fetching channels:", error);
      showToast("Failed to load channels", "error");
    } finally {
      loadingChannels.value = false;
    }
  }

  async function addChannel() {
    const normalizedCategory = newChannel.category.trim().toLowerCase();

    if (!normalizedCategory) {
      showToast("Please enter a category", "error");
      return;
    }

    if (normalizedCategory.length > 50) {
      showToast("Category must be 50 characters or fewer", "error");
      return;
    }

    addingChannel.value = true;
    try {
      const payload: {
        channelUrl: string;
        channelName?: string;
        category: string;
      } = {
        channelUrl: newChannel.channelUrl,
        category: normalizedCategory,
      };
      if (newChannel.channelName.trim()) {
        payload.channelName = newChannel.channelName.trim();
      }

      await api.post("/channels", payload);

      showToast(`Channel added successfully!`);
      newChannel.channelUrl = "";
      newChannel.channelName = "";
      newChannel.category = "";
      await fetchChannels();
    } catch (err: unknown) {
      if (err && typeof err === "object" && "response" in err) {
        const axiosErr = err as { response?: { data?: { error?: string } } };
        showToast(
          axiosErr.response?.data?.error || "Failed to add channel",
          "error"
        );
      } else {
        showToast("Failed to add channel", "error");
      }
    } finally {
      addingChannel.value = false;
    }
  }

  async function deleteChannel(channel: Channel) {
    if (
      !confirm(
        `Are you sure you want to delete "${channel.channelName}" and all its videos?`
      )
    ) {
      return;
    }

    try {
      await api.delete(`/channels/${channel.id}`);
      showToast(`Channel "${channel.channelName}" deleted.`);
      await fetchChannels();
    } catch {
      showToast("Failed to delete channel", "error");
    }
  }

  async function triggerFetch() {
    triggering.value = true;
    try {
      await api.post("/admin/trigger-fetch");
      showToast("Main channel fetch triggered! Processing in background.");
    } catch {
      showToast("Failed to trigger fetch", "error");
    } finally {
      triggering.value = false;
    }
  }

  async function triggerFetchByCategory() {
    const normalizedCategory = selectedFetchCategory.value.trim().toLowerCase();

    if (!normalizedCategory) {
      showToast("Please enter a category", "error");
      return;
    }

    if (normalizedCategory.length > 50) {
      showToast("Category must be 50 characters or fewer", "error");
      return;
    }

    triggeringCategory.value = true;
    try {
      selectedFetchCategory.value = normalizedCategory;
      await api.post("/admin/fetch-category", { category: normalizedCategory });
      showToast(
        `"${normalizedCategory}" channel fetch triggered! Processing in background.`
      );
    } catch (err: unknown) {
      if (err && typeof err === "object" && "response" in err) {
        const axiosErr = err as { response?: { data?: { error?: string } } };
        showToast(
          axiosErr.response?.data?.error || "Failed to trigger category fetch",
          "error"
        );
      } else {
        showToast("Failed to trigger category fetch", "error");
      }
    } finally {
      triggeringCategory.value = false;
    }
  }

  async function toggleCron() {
    togglingCron.value = true;
    try {
      const { data } = await api.post("/admin/cron-status", {
        active: !cronActive.value,
      });
      cronActive.value = data.active;
      showToast(`Fetching ${data.active ? "enabled" : "disabled"}.`);
    } catch {
      showToast("Failed to update cron status", "error");
    } finally {
      togglingCron.value = false;
    }
  }

  function logout() {
    localStorage.removeItem("token");
    router.push({ name: "login" });
  }

  onMounted(async () => {
    await fetchChannels();
    try {
      const { data } = await api.get("/admin/cron-status");
      cronActive.value = data.active;
    } catch {
      // Non-critical — default stays true
    }
  });
</script>

<style scoped>
  .admin-page {
    min-height: 100vh;
  }

  .admin-header {
    background: linear-gradient(135deg, #1e293b 0%, #334155 100%);
    color: white;
    padding: 1.5rem 0;
    margin-bottom: 2rem;
  }

  .header-content {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .admin-header h1 {
    font-size: 1.5rem;
  }

  .logout-btn {
    color: white;
    border-color: rgba(255, 255, 255, 0.3);
  }

  .logout-btn:hover {
    background-color: rgba(255, 255, 255, 0.1);
    color: white;
  }

  .admin-section {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    padding: 1.5rem;
    margin-bottom: 1.5rem;
  }

  .admin-section h2 {
    font-size: 1.15rem;
    margin-bottom: 1rem;
  }

  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
  }

  .section-header h2 {
    margin-bottom: 0;
  }

  .fetch-actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .fetch-category-group {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .fetch-category-group input,
  .fetch-category-group select {
    padding: 0.45rem 0.6rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    font-size: 0.875rem;
    background: var(--color-surface);
    color: var(--color-text);
  }

  .table-filters {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
  }

  .table-filters label {
    font-size: 0.85rem;
    font-weight: 500;
  }

  .table-filters select {
    padding: 0.45rem 0.6rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    font-size: 0.875rem;
    background: var(--color-surface);
    color: var(--color-text);
  }

  .btn-secondary {
    background: transparent;
    color: var(--color-primary);
    border: 1px solid var(--color-primary);
    border-radius: var(--radius-sm);
    padding: 0.45rem 0.9rem;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    transition:
      background 0.15s,
      color 0.15s;
  }

  .btn-secondary:hover:not(:disabled) {
    background: var(--color-primary);
    color: white;
  }

  .btn-secondary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .toggle-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    padding: 0.45rem 0.9rem;
    border-radius: 999px;
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
    border: 2px solid transparent;
    transition:
      background 0.2s,
      color 0.2s,
      border-color 0.2s;
    white-space: nowrap;
  }

  .toggle-btn.active {
    background: #dcfce7;
    color: #15803d;
    border-color: #86efac;
  }

  .toggle-btn.inactive {
    background: var(--color-border);
    color: var(--color-text-secondary);
    border-color: var(--color-border);
  }

  .toggle-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .toggle-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: currentColor;
    flex-shrink: 0;
  }

  .category-badge {
    display: inline-block;
    padding: 0.2rem 0.55rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: capitalize;
    letter-spacing: 0.03em;
  }

  .category-main {
    background: #dbeafe;
    color: #1d4ed8;
  }

  .category-entertainment {
    background: #fce7f3;
    color: #9d174d;
  }

  .form-row {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 1rem;
    margin-bottom: 1rem;
  }

  @media (max-width: 768px) {
    .form-row {
      grid-template-columns: 1fr;
    }
  }

  .form-group label {
    display: block;
    font-size: 0.85rem;
    font-weight: 500;
    margin-bottom: 0.375rem;
  }

  .label-hint {
    font-weight: 400;
    color: var(--text-muted, #888);
    font-size: 0.8rem;
  }

  .channels-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.875rem;
  }

  .channels-table th,
  .channels-table td {
    text-align: left;
    padding: 0.75rem;
    border-bottom: 1px solid var(--color-border);
  }

  .channels-table th {
    font-weight: 600;
    color: var(--color-text-secondary);
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .btn-sm {
    padding: 0.25rem 0.5rem;
    font-size: 0.75rem;
  }

  .loading {
    text-align: center;
    padding: 2rem 0;
    color: var(--color-text-secondary);
  }

  .spinner {
    width: 32px;
    height: 32px;
    border: 3px solid var(--color-border);
    border-top-color: var(--color-primary);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    margin: 0 auto 0.75rem;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .empty-state {
    text-align: center;
    padding: 2rem;
    color: var(--color-text-secondary);
  }

  .toast {
    position: fixed;
    bottom: 2rem;
    right: 2rem;
    padding: 0.75rem 1.5rem;
    border-radius: var(--radius-sm);
    color: white;
    font-size: 0.875rem;
    font-weight: 500;
    box-shadow: var(--shadow-lg);
    z-index: 1000;
    animation: slideIn 0.3s ease;
  }

  .toast.success {
    background-color: var(--color-success);
  }

  .toast.error {
    background-color: var(--color-danger);
  }

  @keyframes slideIn {
    from {
      transform: translateX(100%);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }
</style>
