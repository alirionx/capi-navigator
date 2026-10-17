import { hasRole, type Role } from '@capi-navigator/shared';
import type { Pinia } from 'pinia';
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { onUnauthorized } from '../api/client.js';
import { useAuthStore } from '../stores/auth.js';
import ChangePasswordView from '../views/ChangePasswordView.vue';
import HomeView from '../views/HomeView.vue';
import LoginView from '../views/LoginView.vue';
import UsersView from '../views/UsersView.vue';

declare module 'vue-router' {
  interface RouteMeta {
    /** Reachable without a session. */
    public?: boolean;
    /** Minimum role; hides the route for others (FP1-F-07, cosmetic only). */
    minRole?: Role;
    /** Navigation entry. */
    titleKey?: string;
    icon?: string;
  }
}

export const routes: RouteRecordRaw[] = [
  { path: '/login', name: 'login', component: LoginView, meta: { public: true } },
  {
    path: '/change-password',
    name: 'change-password',
    component: ChangePasswordView,
    meta: { minRole: 'viewer' },
  },
  {
    path: '/',
    name: 'home',
    component: HomeView,
    meta: { minRole: 'viewer', titleKey: 'nav.home', icon: 'mdi-home' },
  },
  {
    path: '/users',
    name: 'users',
    component: UsersView,
    meta: { minRole: 'admin', titleKey: 'nav.users', icon: 'mdi-account-multiple' },
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

export function createAppRouter(pinia: Pinia) {
  const router = createRouter({ history: createWebHistory(), routes });

  router.beforeEach(async (to) => {
    const auth = useAuthStore(pinia);
    if (!auth.checked) await auth.fetchMe().catch(() => undefined);

    if (to.meta.public) {
      return to.name === 'login' && auth.me ? { name: 'home' } : true;
    }
    if (!auth.me) {
      return { name: 'login', query: to.fullPath !== '/' ? { redirect: to.fullPath } : {} };
    }
    if (auth.me.mustChangePassword && to.name !== 'change-password') {
      return { name: 'change-password' };
    }
    if (to.meta.minRole && !hasRole(auth.me.role, to.meta.minRole)) return { name: 'home' };
    return true;
  });

  // Session expired or revoked while using the app: back to the login page.
  onUnauthorized(() => {
    const auth = useAuthStore(pinia);
    auth.clear();
    const current = router.currentRoute.value;
    if (!current.meta.public) {
      void router.replace({ name: 'login', query: { redirect: current.fullPath } });
    }
  });

  return router;
}
