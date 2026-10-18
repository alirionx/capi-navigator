import type { Permission } from '@capi-navigator/shared';
import type { Pinia } from 'pinia';
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { onUnauthorized } from '../api/client.js';
import { useAuthStore } from '../stores/auth.js';
import AddonsView from '../views/AddonsView.vue';
import ChangePasswordView from '../views/ChangePasswordView.vue';
import ClusterDetailView from '../views/ClusterDetailView.vue';
import ClustersView from '../views/ClustersView.vue';
import ClusterWizardView from '../views/ClusterWizardView.vue';
import ConnectionsView from '../views/ConnectionsView.vue';
import CredentialsView from '../views/CredentialsView.vue';
import HelmRepositoriesView from '../views/HelmRepositoriesView.vue';
import HomeView from '../views/HomeView.vue';
import LoginView from '../views/LoginView.vue';
import ProvidersView from '../views/ProvidersView.vue';
import RolesView from '../views/RolesView.vue';
import UsersView from '../views/UsersView.vue';

declare module 'vue-router' {
  interface RouteMeta {
    /** Reachable without a session. */
    public?: boolean;
    /** Minimum role; hides the route for others (FP1-F-07, cosmetic only). */
    /** Permission needed somewhere to open the page (FP19-F-10). */
    permission?: Permission;
    /** Navigation entry. */
    titleKey?: string;
    icon?: string;
    /** Navigation section the entry is listed under. */
    navGroup?: 'overview' | 'management' | 'administration';
  }
}

export const routes: RouteRecordRaw[] = [
  { path: '/login', name: 'login', component: LoginView, meta: { public: true } },
  {
    path: '/change-password',
    name: 'change-password',
    component: ChangePasswordView,
    // Signed-in only: reachable while the password change is pending.
    meta: {},
  },
  {
    path: '/',
    name: 'home',
    component: HomeView,
    // Signed-in only: the fallback for pages without permission (no redirect loop).
    meta: { titleKey: 'nav.home', icon: 'mdi-home', navGroup: 'overview' },
  },
  {
    path: '/clusters',
    name: 'clusters',
    component: ClustersView,
    meta: {
      permission: 'view',
      titleKey: 'nav.clusters',
      icon: 'mdi-server-network',
      navGroup: 'overview',
    },
  },
  {
    path: '/clusters/new',
    name: 'cluster-new',
    component: ClusterWizardView,
    meta: { permission: 'clusters.create' },
  },
  {
    path: '/clusters/:namespace/:name',
    name: 'cluster',
    component: ClusterDetailView,
    props: true,
    meta: { permission: 'view' },
  },
  {
    path: '/addons',
    name: 'addons',
    component: AddonsView,
    meta: {
      permission: 'view',
      titleKey: 'nav.addons',
      icon: 'mdi-package-variant-closed',
      navGroup: 'overview',
    },
  },
  {
    path: '/connections',
    name: 'connections',
    component: ConnectionsView,
    meta: {
      permission: 'view',
      titleKey: 'nav.connections',
      icon: 'mdi-lan-connect',
      navGroup: 'management',
    },
  },
  {
    path: '/providers',
    name: 'providers',
    component: ProvidersView,
    meta: {
      permission: 'view',
      titleKey: 'nav.providers',
      icon: 'mdi-puzzle',
      navGroup: 'management',
    },
  },
  {
    path: '/credentials',
    name: 'credentials',
    component: CredentialsView,
    meta: {
      permission: 'view',
      titleKey: 'nav.credentials',
      icon: 'mdi-key-chain',
      navGroup: 'management',
    },
  },
  {
    path: '/helm-repositories',
    name: 'helm-repositories',
    component: HelmRepositoriesView,
    meta: {
      permission: 'view',
      titleKey: 'nav.helmRepositories',
      icon: 'mdi-database-outline',
      navGroup: 'management',
    },
  },
  {
    path: '/users',
    name: 'users',
    component: UsersView,
    meta: {
      permission: 'users.manage',
      titleKey: 'nav.users',
      icon: 'mdi-account-multiple',
      navGroup: 'administration',
    },
  },
  {
    path: '/roles',
    name: 'roles',
    component: RolesView,
    meta: {
      permission: 'users.manage',
      titleKey: 'nav.roles',
      icon: 'mdi-shield-account',
      navGroup: 'administration',
    },
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
    if (to.meta.permission && !auth.can(to.meta.permission)) return { name: 'home' };
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
