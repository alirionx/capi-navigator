import { createI18n } from 'vue-i18n';
import { en, type MessageSchema } from './en.js';

export function createAppI18n() {
  return createI18n<[MessageSchema], 'en'>({
    legacy: false,
    locale: 'en',
    fallbackLocale: 'en',
    messages: { en },
  });
}
