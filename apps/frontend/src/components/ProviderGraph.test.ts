import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import type { ClusterNamespace, ClusterSummary } from '@capi-navigator/shared';
import { createAppI18n } from '../i18n/index.js';
import ProviderGraph from './ProviderGraph.vue';

const cluster = (name: string) =>
  ({
    name,
    namespace: 'default',
    phase: 'Provisioned',
    ready: true,
    machines: [],
  }) as unknown as ClusterSummary;
const render = (namespaces?: Record<string, ClusterNamespace[]>) =>
  mount(ProviderGraph, {
    props: {
      providers: [],
      clusters: [cluster('prod'), cluster('stage')],
      ...(namespaces ? { namespaces: new Map(Object.entries(namespaces)) } : {}),
    },
    global: {
      plugins: [createAppI18n(), createVuetify({ components })],
      stubs: {
        RouterLink: {
          props: ['to'],
          template: '<a :data-tab="to.query?.tab" :data-cluster="to.params.name"><slot /></a>',
        },
      },
    },
  });
const ns = (...names: string[]) => names.map((name) => ({ name, ready: name !== 'new' }));

describe('ProviderGraph: managed namespaces (UX-17)', () => {
  it('shows them next to the nodes of their cluster, as links to its namespaces', () => {
    const w = render({ 'default/prod': ns('team-a', 'new') });
    const cards = w.findAll('[data-testid=cluster-namespaces]');
    expect(cards).toHaveLength(1);
    expect(cards[0]!.text()).toContain('2 namespaces');
    const links = w.findAll('[data-testid=graph-namespace]');
    expect(links.map((l) => l.attributes('title'))).toEqual(['team-a: Ready', 'new: Installing']);
    expect(links[0]!.attributes()).toMatchObject({
      'data-tab': 'namespaces',
      'data-cluster': 'prod',
    });
  });

  it('keeps the height of a node with many namespaces', () => {
    const w = render({ 'default/prod': ns('a', 'b', 'c', 'd', 'e') });
    expect(w.findAll('[data-testid=graph-namespace]')).toHaveLength(3);
    expect(w.find('[data-testid=cluster-namespaces]').text()).toContain('+2');
  });

  it('has no such column without namespaces', () => {
    for (const w of [render(), render({})]) {
      expect(w.find('.header.namespaces').exists()).toBe(false);
      expect(w.find('[data-testid=cluster-namespaces]').exists()).toBe(false);
      expect(w.find('.link').exists()).toBe(false);
    }
  });
});
