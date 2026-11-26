import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { nextTick, ref } from 'vue';
import { createVuetify } from 'vuetify';
import * as components from 'vuetify/components';
import { createAppI18n } from '../../i18n/index.js';
import CustomizationEditor from './CustomizationEditor.vue';

// Without a browser the editor falls back to a text area with the same test id.
vi.mock('../../monaco/setup.js', () => {
  throw new Error('no Monaco in tests');
});

interface Customization {
  files: { path: string; content?: string; permissions?: string }[];
  preCommands: string[];
  postCommands: string[];
}

const render = (c: Customization = { files: [], preCommands: ['echo a'], postCommands: [] }) => {
  const model = ref(c);
  const w = mount(CustomizationEditor, {
    props: {
      modelValue: model.value,
      'onUpdate:modelValue': (v: Customization) => (model.value = v),
    },
    global: { plugins: [createAppI18n(), createVuetify({ components })] },
  });
  return { w, model };
};

describe('node customization editor (FP5-F-13, UX-19)', () => {
  it('keeps the commands as a list without empty lines, and the typed text as it is', async () => {
    const { w, model } = render();
    await flushPromises();
    const pre = w.get('[data-testid=custom-pre] textarea');
    await pre.setValue('echo a\n\necho b\n');
    expect(model.value.preCommands).toEqual(['echo a', 'echo b']);
    // The new last line stays, so the cursor does not jump while typing.
    expect((pre.element as HTMLTextAreaElement).value).toBe('echo a\n\necho b\n');
  });

  it('shows commands changed from outside', async () => {
    const { w, model } = render();
    await flushPromises();
    model.value.preCommands.splice(0, 1, 'systemctl restart x');
    await nextTick();
    await nextTick();
    expect((w.get('[data-testid=custom-pre] textarea').element as HTMLTextAreaElement).value).toBe(
      'systemctl restart x',
    );
  });

  it('edits the content of a file', async () => {
    const { w, model } = render({
      files: [{ path: '/etc/x.yaml', content: 'a: 1', permissions: '0644' }],
      preCommands: [],
      postCommands: [],
    });
    await flushPromises();
    await w.get('[data-testid=custom-file-content-0] textarea').setValue('a: 2');
    expect(model.value.files).toEqual([
      { path: '/etc/x.yaml', content: 'a: 2', permissions: '0644' },
    ]);
  });
});
