<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { useDisplay } from 'vuetify';
import { routes } from './router/index.js';
import AppLogo from './components/AppLogo.vue';
import ConnectionSelector from './components/ConnectionSelector.vue';
import { useThemeSwitch } from './composables/theme.js';
import { useAuthStore } from './stores/auth.js';
import { useConnectionsStore } from './stores/connections.js';

const { t } = useI18n();
const { theme, toggle: toggleTheme } = useThemeSwitch();
const dark = computed(() => theme.global.current.value.dark);
const { mdAndUp } = useDisplay();
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const connections = useConnectionsStore();
const drawer = ref(mdAndUp.value);
watch(mdAndUp, (wide) => (drawer.value = wide));

/** The full layout is shown only to signed-in users with an active password. */
const fullLayout = computed(() => auth.me !== null && !route.meta.public);

// Navigation entries by role; hiding is cosmetic, the backend enforces roles (FP1-F-07).
const NAV_GROUPS = ['overview', 'management', 'administration'] as const;
const navGroups = computed(() =>
  NAV_GROUPS.map((group) => ({
    group,
    items: routes
      .filter(
        (r) =>
          r.meta?.titleKey &&
          r.meta.navGroup === group &&
          (!r.meta.minRole || auth.can(r.meta.minRole)),
      )
      .map((r) => ({
        to: r.path,
        title: r.meta!.titleKey!,
        icon: r.meta!.icon ?? 'mdi-circle-small',
      })),
  })).filter((g) => g.items.length > 0),
);

// Load the connections for the selector once the user may use the app.
watch(
  () => fullLayout.value && !auth.me?.mustChangePassword,
  (ready) => {
    if (ready) void connections.load().catch(() => undefined);
  },
  { immediate: true },
);

async function signOut(): Promise<void> {
  await auth.logout();
  await router.replace({ name: 'login' });
}
</script>

<template>
  <v-app>
    <v-navigation-drawer
      v-if="fullLayout"
      v-model="drawer"
      :permanent="mdAndUp"
      width="248"
      border="0"
      class="sidebar"
      :aria-label="t('app.mainNavigation')"
    >
      <router-link
        to="/"
        class="brand d-flex align-center ga-3 px-5 pt-6 pb-8"
        :aria-label="t('nav.home')"
      >
        <AppLogo :size="38" />
        <div>
          <div class="brand-title">{{ t('app.title') }}</div>
          <div class="brand-subtitle">{{ t('app.subtitle') }}</div>
        </div>
      </router-link>

      <v-list nav density="comfortable" class="px-3">
        <template v-for="(g, i) in navGroups" :key="g.group">
          <v-list-subheader class="nav-heading" :class="{ 'mt-4': i > 0 }">{{
            t(`nav.groups.${g.group}`)
          }}</v-list-subheader>
          <v-list-item
            v-for="item in g.items"
            :key="item.to"
            :to="item.to"
            :exact="item.to === '/'"
            :prepend-icon="item.icon"
            :title="t(item.title)"
            rounded="lg"
          />
        </template>
      </v-list>

      <template #append>
        <v-list nav density="comfortable" class="px-3 pb-4">
          <v-list-item
            :prepend-icon="dark ? 'mdi-white-balance-sunny' : 'mdi-weather-night'"
            :title="dark ? t('app.lightMode') : t('app.darkMode')"
            :aria-label="t('app.toggleTheme')"
            role="button"
            rounded="lg"
            @click="toggleTheme"
          />
        </v-list>
      </template>
    </v-navigation-drawer>

    <v-app-bar v-if="fullLayout" flat density="comfortable" class="topbar">
      <v-app-bar-nav-icon v-if="!mdAndUp" @click="drawer = !drawer" />
      <v-spacer />
      <ConnectionSelector v-if="!auth.me?.mustChangePassword" />
      <v-menu v-if="auth.me">
        <template #activator="{ props }">
          <v-btn
            v-bind="props"
            variant="text"
            prepend-icon="mdi-account-circle"
            class="mr-2"
            data-testid="user-menu"
          >
            {{ auth.me.username }}
          </v-btn>
        </template>
        <v-list density="compact">
          <v-list-item
            :title="t('app.signedInAs', { username: auth.me.username })"
            :subtitle="t(`roles.${auth.me.role}`)"
          />
          <v-divider />
          <v-list-item
            prepend-icon="mdi-key"
            :title="t('app.changePassword')"
            :to="{ name: 'change-password' }"
          />
          <v-list-item
            prepend-icon="mdi-logout"
            :title="t('app.signOut')"
            data-testid="sign-out"
            @click="signOut"
          />
        </v-list>
      </v-menu>
    </v-app-bar>

    <v-main>
      <router-view />
    </v-main>
  </v-app>
</template>

<style>
:root {
  --app-font: 'Inter Variable', 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif;
}
.v-application,
.v-application .text-h1,
.v-application .text-h2,
.v-application .text-h3,
.v-application .text-h4,
.v-application .text-h5,
.v-application .text-h6,
.v-application .text-subtitle-1,
.v-application .text-subtitle-2,
.v-application .text-body-1,
.v-application .text-body-2,
.v-application .text-caption,
.v-application .text-button {
  font-family: var(--app-font) !important;
  letter-spacing: normal !important;
}
/* Vuetify 3 tracks out buttons, chips and messages; the shared style uses normal spacing. */
.v-application .v-btn,
.v-application .v-chip,
.v-application .v-messages,
.v-application .v-field,
.v-application .v-label,
.v-application .v-list-item-title,
.v-application .v-stepper-item {
  letter-spacing: normal !important;
}
/* Page header used by the views. */
.page-title {
  font-size: 1.75rem;
  font-weight: 700;
  letter-spacing: -0.01em !important;
  line-height: 1.2;
}
/* Windows (stepper, tabs) clip overflow; leave room for the floating labels of outlined fields. */
.v-application .v-window-item {
  padding-top: 8px;
}
/* Tables and lists sit on a bordered card. */
.table-card {
  overflow: hidden;
}
</style>

<style scoped>
.sidebar {
  background: rgb(var(--v-theme-background)) !important;
}
.topbar {
  background: rgb(var(--v-theme-background)) !important;
  border-bottom: thin solid rgba(var(--v-border-color), var(--v-border-opacity));
}
.brand {
  text-decoration: none;
  color: inherit;
}
.brand-title {
  font-weight: 800;
  font-size: 1.15rem;
  line-height: 1.1;
}
.brand-subtitle {
  font-size: 0.75rem;
  opacity: 0.75;
}
.sidebar :deep(.v-list-item__spacer) {
  width: 14px !important;
}
.nav-heading {
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.08em !important;
  text-transform: uppercase;
}
.sidebar :deep(.v-list-item--active) {
  background: rgb(var(--v-theme-surface-variant));
  color: rgb(var(--v-theme-on-surface));
}
.sidebar :deep(.v-list-item--active .v-list-item__overlay) {
  opacity: 0;
}
.sidebar :deep(.v-list-item--active .v-icon) {
  color: rgb(var(--v-theme-primary));
}
</style>
