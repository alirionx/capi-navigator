import { describe, expect, it } from 'vitest';
import { editorLanguage } from './editor-language.js';

describe('highlighting of customization files (UX-19)', () => {
  it('follows the file name', () => {
    expect(editorLanguage('/etc/rancher/rke2/config.yaml.d/disable-ingress.yaml')).toBe('yaml');
    expect(editorLanguage('/etc/app.YML')).toBe('yaml');
    expect(editorLanguage('/usr/local/bin/prepare.sh')).toBe('shell');
    expect(editorLanguage('/etc/sysctl.d/90-net.conf')).toBe('ini');
    expect(editorLanguage('/etc/containerd/config.toml')).toBe('ini');
    expect(editorLanguage('/etc/hosts')).toBe('plaintext');
    expect(editorLanguage('')).toBe('plaintext');
  });
});
