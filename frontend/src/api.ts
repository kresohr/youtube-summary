import axios from "axios";

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || "/api",
});

// Add auth token to requests
api.interceptors.request.use((config) => {
  const token = localStorage.getItem("token");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Handle 401 responses
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem("token");
      // Use the router base path to build the redirect URL
      const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
      window.location.href = `${basePath}/configure`;
    }
    return Promise.reject(error);
  }
);

export default api;
