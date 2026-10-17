// Monaco Editor setup, loaded lazily so it stays out of the main bundle.
// Only the core editor and YAML highlighting are included; YAML views are read-only.
import * as monaco from 'monaco-editor/editor/editor.api';
import 'monaco-editor/languages/definitions/yaml/register';
// Icon font for folding, diff navigation and hidden-region markers.
import 'monaco-editor/features/codicon/register';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';

declare global {
  interface Window {
    MonacoEnvironment?: { getWorker: (workerId: string, label: string) => Worker };
  }
}

window.MonacoEnvironment = { getWorker: () => new EditorWorker() };

export { monaco };
