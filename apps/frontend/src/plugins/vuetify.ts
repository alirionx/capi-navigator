import '@mdi/font/css/materialdesignicons.css';
import 'vuetify/styles';
import { createVuetify } from 'vuetify';

// NF-10: light and dark theme; the initial theme follows the OS preference.
export function createAppVuetify() {
  const prefersDark =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches;
  return createVuetify({
    theme: { defaultTheme: prefersDark ? 'dark' : 'light' },
  });
}
