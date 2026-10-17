import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import HomeView from '../views/HomeView.vue';

export const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'home',
    component: HomeView,
    meta: { titleKey: 'nav.home', icon: 'mdi-home' },
  },
];

export function createAppRouter() {
  return createRouter({ history: createWebHistory(), routes });
}
