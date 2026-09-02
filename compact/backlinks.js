import { BACKLINK_START, BACKLINK_END, stripManagedBlock } from './graph.js';

export const BACKLINK_THRESHOLD = 2;

export function hasManagedBlock(body) {
  return body.includes(BACKLINK_START) && body.includes(BACKLINK_END);
}

function render(citers) {
  const lines = [...new Set(citers)].sort().map((id) => `- [[${id}]]`);
  return `${BACKLINK_START}\n## Referenced by\n${lines.join('\n')}\n${BACKLINK_END}`;
}

// Always strips first, so the result is a pure function of (bare body, citers).
// That is what makes a second run with unchanged citers byte-identical.
export function applyBacklinks(body, citers, threshold = BACKLINK_THRESHOLD) {
  const bare = stripManagedBlock(body);
  const unique = [...new Set(citers)];
  if (unique.length < threshold) return bare;
  return bare ? `${bare}\n${render(unique)}` : render(unique);
}
