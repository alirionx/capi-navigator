import { createPinia } from 'pinia';
import { createApp } from 'vue';
import App from './App.vue';
import { createAppI18n } from './i18n/index.js';
import { createAppVuetify } from './plugins/vuetify.js';
import { createAppRouter } from './router/index.js';

const pinia = createPinia();

createApp(App)
  .use(pinia)
  .use(createAppRouter(pinia))
  .use(createAppI18n())
  .use(createAppVuetify())
  .mount('#app');
