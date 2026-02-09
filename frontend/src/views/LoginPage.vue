<template>
  <div class="login-page">
    <div class="login-card">
      <h1>🔐 Admin Login</h1>
      <p class="login-subtitle">YouTube Summary System</p>

      <form @submit.prevent="handleLogin">
        <div class="form-group">
          <label for="username">Username</label>
          <input
            id="username"
            v-model="username"
            type="text"
            placeholder="Enter username"
            required
            autocomplete="username"
          />
        </div>

        <div class="form-group">
          <label for="password">Password</label>
          <input
            id="password"
            v-model="password"
            type="password"
            placeholder="Enter password"
            required
            autocomplete="current-password"
          />
        </div>

        <p v-if="error" class="error-msg">{{ error }}</p>

        <button type="submit" class="btn-primary login-btn" :disabled="loading">
          {{ loading ? 'Logging in...' : 'Login' }}
        </button>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import api from '../api';

const router = useRouter();

const username = ref('');
const password = ref('');
const error = ref('');
const loading = ref(false);

async function handleLogin() {
  error.value = '';
  loading.value = true;

  try {
    const { data } = await api.post('/auth/login', {
      username: username.value,
      password: password.value,
    });

    localStorage.setItem('token', data.token);
    router.push({ name: 'admin' });
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'response' in err) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      error.value = axiosErr.response?.data?.error || 'Login failed';
    } else {
      error.value = 'Network error. Please try again.';
    }
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.login-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #1e293b 0%, #334155 100%);
  padding: 1rem;
}

.login-card {
  background: var(--color-surface);
  padding: 2.5rem;
  border-radius: var(--radius);
  box-shadow: var(--shadow-lg);
  width: 100%;
  max-width: 400px;
}

.login-card h1 {
  font-size: 1.5rem;
  text-align: center;
  margin-bottom: 0.25rem;
}

.login-subtitle {
  text-align: center;
  color: var(--color-text-secondary);
  font-size: 0.875rem;
  margin-bottom: 2rem;
}

.form-group {
  margin-bottom: 1.25rem;
}

.form-group label {
  display: block;
  font-size: 0.85rem;
  font-weight: 500;
  margin-bottom: 0.375rem;
  color: var(--color-text);
}

.error-msg {
  color: var(--color-danger);
  font-size: 0.85rem;
  margin-bottom: 1rem;
  text-align: center;
}

.login-btn {
  width: 100%;
  padding: 0.75rem;
  font-size: 1rem;
}

.login-btn:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}
</style>
