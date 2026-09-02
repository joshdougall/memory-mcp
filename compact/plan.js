// compact/plan.js
import { disposition, reportFlags, TOMBSTONE_TAG, TOMBSTONE_TTL } from './disposition.js';
import { applyBacklinks, hasManagedBlock } from './backlinks.js';

const MALFORMED_PROJECT = '""';

function base(entry) {
  return {
    id: entry.id, title: entry.title, body: entry.body, type: entry.type,
    tags: [...entry.tags], source: entry.source, project: entry.project,
  };
}

export function planEntry(entry, graph) {
  const d = disposition(entry, graph);
  const flags = reportFlags(entry, graph);

  if (d === 'tombstone') {
    const w = base(entry);
    if (!w.tags.includes(TOMBSTONE_TAG)) w.tags.push(TOMBSTONE_TAG);
    w.ttl = TOMBSTONE_TTL;
    return { id: entry.id, disposition: d, flags, actions: ['tombstone'], write: w };
  }

  if (d === 'rescue') {
    const w = base(entry);
    w.tags = w.tags.filter((t) => t !== TOMBSTONE_TAG);
    return { id: entry.id, disposition: d, flags, actions: ['rescue'], write: w };
  }

  if (d !== 'none') return { id: entry.id, disposition: d, flags, actions: [], write: null };

  const w = base(entry);
  const actions = [];

  if (w.project === MALFORMED_PROJECT) {
    w.project = '';
    actions.push('schema');
  }

  const hadBlock = hasManagedBlock(w.body);
  const newBody = applyBacklinks(w.body, [...(graph.inbound.get(entry.id) || [])]);
  if (newBody !== w.body) {
    w.body = newBody;
    actions.push(hadBlock && !hasManagedBlock(newBody) ? 'backlinks-removed' : 'backlinks');
  }

  return { id: entry.id, disposition: d, flags, actions, write: actions.length ? w : null };
}

export function planStubs(graph) {
  return [...graph.dangling.entries()].map(([id, citers]) => ({
    id,
    title: id,
    // NO wikilinks and NO managed block. A threshold-1 block here would be
    // removed by the next run, which evaluates the stub as an ordinary entry at
    // threshold 2, so every stub would churn on alternate runs. Who cited it is
    // in the run log and the report; if it reaches two citers the ordinary
    // backlink pass gives it a block like anything else.
    body: [
      'Created by the memory compaction pass to resolve a dangling link.',
      `Cited by ${citers.size} entr${citers.size === 1 ? 'y' : 'ies'} at creation time.`,
      'No content yet.',
    ].join('\n'),
    type: 'entity',
    tags: ['stub'],
    source: 'memory-compaction',
    project: '',
  }));
}
