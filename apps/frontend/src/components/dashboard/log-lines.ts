/** One line of `kubectl logs --timestamps` output, split and classified for display (FP18-F-07). */
export interface LogLine {
  /** Line number in the fetched text, 1-based. */
  n: number;
  /** RFC 3339 timestamp from the kubelet, shown only on request. */
  time?: string;
  text: string;
  level: 'error' | 'warn' | 'info';
  /** Matches the filter (all lines without one). */
  match: boolean;
}

const TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})) (.*)$/;
const ERROR =
  /\b(error|err|fatal|panic|exception|failed|crit(ical)?)\b|level=(error|fatal)|"level":"(error|fatal)"/i;
const WARN = /\b(warn|warning)\b|level=warn|"level":"warn(ing)?"/i;

export function logLines(text: string, filter: string, withTime: boolean): LogLine[] {
  const raw = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (!raw) return [];
  const needle = filter.trim().toLowerCase();
  return raw.split('\n').map((line, i) => {
    const m = TIMESTAMP.exec(line);
    const body = m ? m[2]! : line;
    return {
      n: i + 1,
      ...(withTime && m ? { time: m[1]! } : {}),
      text: body,
      level: ERROR.test(body) ? 'error' : WARN.test(body) ? 'warn' : 'info',
      match: !needle || body.toLowerCase().includes(needle),
    };
  });
}
