import { useTheme } from 'vuetify';

// NF-10: light/dark theme, dark by default, remembered in local storage (a per-browser convenience).
export type ThemeName = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'capi-navigator-theme';

/** The stored theme; dark if nothing (or something invalid) is stored. */
export function storedTheme(): ThemeName {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function useThemeSwitch() {
  const theme = useTheme();

  function setTheme(name: ThemeName): void {
    theme.global.name.value = name;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, name);
    } catch {
      // Storage unavailable (private mode): the choice lasts for this page only.
    }
  }

  function toggle(): void {
    setTheme(theme.global.current.value.dark ? 'light' : 'dark');
  }

  return { theme, setTheme, toggle };
}
