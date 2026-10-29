# ADR-0031: Vuetify 4

- Status: accepted
- Date: 2026-10-29
- Pack: UX (recurring)
- Refines: section 4 of the requirements (UI: Vuetify 3)

## Context

The requirements name Vuetify 3 as the UI library. Vuetify 4 (4.0.0 in February 2026, 4.3.1 in
October 2026) is the maintained major; Vuetify 3 only gets fixes. The upgrade guide
(`packages/docs/src/pages/en/getting-started/upgrade-guide.md` in vuetifyjs/vuetify v4.3.1) lists
these breaking changes that touch the app:

- Typography follows Material Design 3: `text-h1` … `text-caption` become `text-display-*`,
  `text-headline-*`, `text-title-*`, `text-body-*` and `text-label-*`.
- The grid uses CSS `gap` instead of negative margins; `<v-row dense>` becomes
  `density="compact"`.
- Smaller default breakpoints (md 840 px instead of 960 px, lg 1145 px instead of 1280 px).
- No global CSS reset; all Vuetify styles sit in cascade layers.
- In the `item` slot of select, combobox and autocomplete, `item` is the raw item; the wrapped one
  is `internalItem`.

## Decision

Upgrade to Vuetify 4 and adopt its defaults instead of restoring Vuetify 3 behaviour:

- MD3 typography classes, mapped with the "conservative mapping" of the typography migration guide
  (same sizes except headings).
- The new breakpoints; the navigation drawer becomes permanent from 840 px.
- Grid with `gap`; spacing is set by the grid and by `hide-details="auto"` on form fields.
- A small reset for headings, paragraphs and lists in the `vuetify-core.reset` layer, as the
  upgrade guide suggests, because the app uses plain `<h1>`, `<p>` and `<ul>` elements.

No other part of the stack changes; `vite-plugin-vuetify` 2 and Vue 3.5 support Vuetify 4.

## Consequences

- Renovate allows Vuetify below 5.
- Screens look slightly different (MD3 headings, gaps); the UI tour screenshots are taken again.
