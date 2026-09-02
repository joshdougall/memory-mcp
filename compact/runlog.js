// compact/runlog.js
import { openSync, writeSync, fsyncSync, closeSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class RunLog {
  constructor(dir, now = new Date()) {
    const logDir = join(dir, 'log');
    mkdirSync(logDir, { recursive: true });
    this.path = join(logDir, `${now.toISOString().slice(0, 10)}.jsonl`);
    this.fd = openSync(this.path, 'a');
    this.records = [];
  }

  // Persist FIRST, then remember. If the disk write fails, this throws and the
  // record never enters `records`, so a phantom intent cannot inflate
  // writesLanded() and turn a local failure into a reported partial write.
  // fsync on every record because an intent that is not durable is not an
  // intent.
  record(kind, fields = {}) {
    const rec = { ts: new Date().toISOString(), kind, ...fields };
    const line = JSON.stringify(rec) + '\n';
    writeSync(this.fd, line);
    fsyncSync(this.fd);
    this.records.push(rec);
  }

  counts() {
    const out = {};
    for (const r of this.records) out[r.kind] = (out[r.kind] || 0) + 1;
    return out;
  }

  // A `rejected` write is a confirmed non-write. Everything else counts,
  // including an intent with no outcome: the write may have committed and lost
  // its response, and reporting a write that did not happen is safer than
  // missing one that did.
  writesLanded() {
    const rejected = new Set(
      this.records.filter((r) => r.kind === 'rejected').map((r) => r.operation_id),
    );
    return this.records.filter(
      (r) => r.kind === 'intent' && !rejected.has(r.operation_id),
    ).length;
  }

  close() {
    try { closeSync(this.fd); } catch { /* best effort */ }
  }
}

export function writeReport(dir, plans, extras = {}) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'report.md');
  const { includeActions = false, stubs = [], ...sections } = extras;
  const lines = ['# Memory compaction report', '', `Generated ${new Date().toISOString()}`, ''];

  const flagged = plans.filter((p) => p.flags.length > 0);
  lines.push('## Needs a human', '');
  if (flagged.length === 0) lines.push('Nothing this run.', '');
  else {
    for (const p of flagged) lines.push(`- \`${p.id}\` (${p.disposition}): ${p.flags.join(', ')}`);
    lines.push('');
  }

  if (includeActions) {
    const acting = plans.filter((p) => p.actions.length > 0);
    lines.push('## Intended actions', '');
    if (acting.length === 0 && stubs.length === 0) lines.push('None.', '');
    else {
      for (const p of acting) lines.push(`- \`${p.id}\` (${p.disposition}): ${p.actions.join(', ')}`);
      for (const id of stubs) lines.push(`- \`${id}\`: create stub`);
      lines.push('');
      const tally = {};
      for (const p of acting) for (const a of p.actions) tally[a] = (tally[a] || 0) + 1;
      if (stubs.length) tally.stub = stubs.length;
      lines.push('### Counts', '');
      for (const [a, n] of Object.entries(tally).sort()) lines.push(`- ${a}: ${n}`);
      if (stubs.length) {
        lines.push('', 'Stub count is an **upper bound**: only the create itself reveals a');
        lines.push('retained revision counter from a previously deleted id.');
      }
      lines.push('');
    }
    lines.push('## Dispositions', '');
    const byDisp = {};
    for (const p of plans) byDisp[p.disposition] = (byDisp[p.disposition] || 0) + 1;
    for (const [d, n] of Object.entries(byDisp).sort()) lines.push(`- ${d}: ${n}`);
    lines.push('');
  }

  for (const [heading, items] of Object.entries(sections)) {
    if (!items || items.length === 0) continue;
    lines.push(`## ${heading}`, '');
    for (const item of items) lines.push(`- ${item}`);
    lines.push('');
  }

  writeFileSync(path, lines.join('\n'));
  return path;
}
