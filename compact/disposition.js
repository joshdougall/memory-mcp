// compact/disposition.js
export const TOMBSTONE_TAG = 'compaction-tombstone';
export const TOMBSTONE_TTL = 2592000;
export const DOCUMENTED_TYPES = [
  'pattern', 'decision', 'reference', 'feedback', 'incident', 'project', 'entity', 'state',
];

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const STAMP = /\d{8}-\d{6}/;

export function isGeneratorShaped(id) {
  return UUID.test(id) || STAMP.test(id);
}

// Provenance is the TAG ALONE. Keying it on the TTL would let an entry whose
// expiry was cleared externally be re-tombstoned as if it were fresh junk, and
// would let it rescue another tombstone.
const isOurs = (e) => e.tags.includes(TOMBSTONE_TAG);

const isMachineExhaust = (e) =>
  !DOCUMENTED_TYPES.includes(e.type) && isGeneratorShaped(e.id);

const citers = (entry, graph) => [...(graph.inbound.get(entry.id) || [])];

// A tombstoned citer does not count for rescue: two machine-exhaust entries
// citing each other would otherwise keep one another alive forever. Such a
// citer still counts for ordinary link protection, which is why `hold` uses the
// unfiltered list.
function rescuers(entry, graph) {
  return citers(entry, graph).filter((id) => {
    const c = graph.byId.get(id);
    return c && !isOurs(c);
  });
}

export function disposition(entry, graph) {
  if (isOurs(entry)) return rescuers(entry, graph).length > 0 ? 'rescue' : 'leave';
  if (entry.ttl) return 'foreign-ttl';
  if (isMachineExhaust(entry)) return citers(entry, graph).length > 0 ? 'hold' : 'tombstone';
  return 'none';
}

export function reportFlags(entry, graph) {
  const flags = [];
  if (disposition(entry, graph) === 'hold') flags.push('held-machine-exhaust');
  if (!DOCUMENTED_TYPES.includes(entry.type) && !isGeneratorShaped(entry.id)) {
    flags.push('undocumented-type');
  }
  return flags;
}
