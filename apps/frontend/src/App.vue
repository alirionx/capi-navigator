<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useTheme } from 'vuetify';
import { routes } from './router/index.js';

const { t } = useI18n();
const theme = useTheme();
const drawer = ref(true);

const navItems = routes.map((r) => ({
  to: r.path,
  title: String(r.meta?.titleKey ?? r.name),
  icon: String(r.meta?.icon ?? 'mdi-circle-small'),
}));

function toggleTheme(): void {
  theme.global.name.value = theme.global.current.value.dark ? 'light' : 'dark';
}
</script>

<template>
  <v-app>
    <v-app-bar density="comfortable" color="primary">
      <v-app-bar-nav-icon @click="drawer = !drawer" />
      <v-app-bar-title>{{ t('app.title') }}</v-app-bar-title>
      <v-btn
        icon="mdi-theme-light-dark"
        :aria-label="t('app.toggleTheme')"
        :title="t('app.toggleTheme')"
        @click="toggleTheme"
      />
    </v-app-bar>

    <v-navigation-drawer v-model="drawer">
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
