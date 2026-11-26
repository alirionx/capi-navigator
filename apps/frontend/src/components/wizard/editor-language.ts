/** Highlighting of a file of the node customization by its name (UX-19); only a help, no check. */
export function editorLanguage(path: string): string {
  const name = path.trim().toLowerCase();
  if (/\.ya?ml$/.test(name)) return 'yaml';
  if (/\.(sh|bash)$/.test(name)) return 'shell';
  if (/\.(conf|cfg|ini|toml|env)$/.test(name)) return 'ini';
  return 'plaintext';
}
