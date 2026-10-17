import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import { createAppI18n } from '../i18n/index.js';
import HomeView from './HomeView.vue';

function mountView() {
  const pinia = createPinia();
  setActivePinia(pinia);
  return mount(HomeView, {
    global: { plugins: [pinia, createAppI18n(), createVuetify({ components })] },
  });
}

describe('HomeView (FP0-F-03)', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows "Backend: OK" when the health endpoint answers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            status: 'ok',
            version: '0.1.0',
            homeCluster: { reachable: true, version: 'v1.34.0' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );
    const wrapper = mountView();
    await flushPromises();
    expect(wrapper.get('[data-testid="backend-status"]').text()).toContain('Backend: OK');
    expect(wrapper.get('[data-testid="home-cluster-status"]').text()).toContain('v1.34.0');
  });

  it('shows an error when the backend is down', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('', { status: 502, statusText: 'Bad Gateway' })),
    );
    const wrapper = mountView();
    await flushPromises();
    expect(wrapper.get('[data-testid="backend-status"]').text()).toContain('Backend: Error');
  });
});
