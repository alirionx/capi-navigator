<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { useTheme } from 'vuetify';
import { routes } from './router/index.js';
import { useAuthStore } from './stores/auth.js';

const { t } = useI18n();
const theme = useTheme();
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const drawer = ref(true);

/** The full layout is shown only to signed-in users with an active password. */
const fullLayout = computed(() => auth.me !== null && !route.meta.public);

// Navigation entries by role; hiding is cosmetic, the backend enforces roles (FP1-F-07).
const navItems = computed(() =>
  routes
    .filter((r) => r.meta?.titleKey && (!r.meta.minRole || auth.can(r.meta.minRole)))
    .map((r) => ({
      to: r.path,
      title: r.meta!.titleKey!,
      icon: r.meta!.icon ?? 'mdi-circle-small',
    })),
);

function toggleTheme(): void {
  theme.global.name.value = theme.global.current.value.dark ? 'light' : 'dark';
}

async function signOut(): Promise<void> {
  await auth.logout();
  await router.replace({ name: 'login' });
}
</script>

<template>
  <v-app>
    <v-app-bar density="comfortable" color="primary">
      <v-app-bar-nav-icon v-if="fullLayout" @click="drawer = !drawer" />
      <v-app-bar-title>{{ t('app.title') }}</v-app-bar-title>
      <v-btn
        icon="mdi-theme-light-dark"
        :aria-label="t('app.toggleTheme')"
        :title="t('app.toggleTheme')"
        @click="toggleTheme"
      />
      <v-menu v-if="auth.me">
        <template #activator="{ props }">
          <v-btn v-bind="props" prepend-icon="mdi-account-circle" data-testid="user-menu">
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

    <v-navigation-drawer v-if="fullLayout" v-model="drawer">
      <v-list nav>
        <v-list-item
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          :prepend-icon="item.icon"
          :title="t(item.title)"
        />
      </v-list>
    </v-navigation-drawer>

    <v-main>
      <router-view />
    </v-main>
  </v-app>
</template>
