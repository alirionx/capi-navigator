import { createPinia } from 'pinia';
import { createApp } from 'vue';
import App from './App.vue';
import { createAppI18n } from './i18n/index.js';
import { createAppVuetify } from './plugins/vuetify.js';
import { createAppRouter } from './router/index.js';

createApp(App)
  .use(createPinia())
  .use(createAppRouter())
  .use(createAppI18n())
  .use(createAppVuetify())
  .mount('#app');
