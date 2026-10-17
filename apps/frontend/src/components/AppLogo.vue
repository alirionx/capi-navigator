<script setup lang="ts">
// Logo: a compass needle (the navigator) over a cluster of nodes, in the accent color.
defineProps<{ size?: number }>();
</script>

<template>
  <svg :width="size ?? 36" :height="size ?? 36" viewBox="0 0 32 32" aria-hidden="true">
    <rect width="32" height="32" rx="9" fill="rgb(var(--v-theme-primary))" />
    <circle
      cx="16"
      cy="16"
      r="9"
      fill="none"
      stroke="rgb(var(--v-theme-on-primary))"
      stroke-width="2.4"
      opacity="0.45"
    />
    <path d="M16 8.5 19 16h-6z" fill="rgb(var(--v-theme-on-primary))" />
    <path d="M16 23.5 13 16h6z" fill="rgb(var(--v-theme-on-primary))" opacity="0.45" />
    <circle cx="16" cy="16" r="1.8" fill="rgb(var(--v-theme-primary))" />
  </svg>
</template>
