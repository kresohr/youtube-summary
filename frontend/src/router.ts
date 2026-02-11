import { createRouter, createWebHistory } from "vue-router";
import SummaryPage from "./views/SummaryPage.vue";
import LoginPage from "./views/LoginPage.vue";
import AdminDashboard from "./views/AdminDashboard.vue";

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: "/",
      name: "home",
      component: SummaryPage,
    },
    {
      path: "/summary",
      name: "summary",
      component: SummaryPage,
    },
    {
      path: "/configure",
      name: "login",
      component: LoginPage,
    },
    {
      path: "/configure/dashboard",
      name: "admin",
      component: AdminDashboard,
      beforeEnter: (_to, _from, next) => {
        const token = localStorage.getItem("token");
        if (!token) {
          next({ name: "login" });
        } else {
          next();
        }
      },
    },
  ],
});

export default router;
