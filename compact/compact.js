// compact/compact.js
import { randomUUID } from 'node:crypto';
import { buildGraph } from './graph.js';
import { planEntry, planStubs } from './plan.js';
import { RunLog, writeReport } from './runlog.js';
import {
  connect, census, setEntry, health, withDeadline,
  TruncatedCensusError, DeadlineError, CENSUS_CAP,
} from './store.js';
import * as defaultStore from './store.js';

export const EXIT = { OK: 0, MCP: 1, BUDGET: 2, TRUNCATED: 3, PARTIAL: 4, LOCKED: 5, LOCAL: 6, COMPROMISED: 7 };

const NO_WRITE = new Set(['leave', 'foreign-ttl', 'hold']);

class LocalError extends Error {}

export async function run({
  dir, url, base, token = '', dryRun = false, budgetMs = 600000,
  censusCap = CENSUS_CAP, now = new Date(),
}) {
  let log = null;
  try {
    try {
      log = new RunLog(dir, now);
    } catch {
      return EXIT.LOCAL;
    }

    const deadline = Date.now() + budgetMs;
    const remaining = () => deadline - Date.now();
    // Checked after EVERY await, not only at loop tops, and every MCP call is
    // raced against whatever budget is left, so the last operation cannot
    // complete past the deadline and still report success.
    const check = () => { if (remaining() <= 0) throw new DeadlineError('budget exhausted'); };
    const bounded = (promise, label) => {
      check();
      // Math.max(0, ...) because argument evaluation samples remaining() a
      // second time, microseconds after check() sampled it: without the
      // clamp that second read can be negative and setTimeout would warn
      // (Node clamps it to ~1ms anyway, so this only avoids the warning).
      return withDeadline(promise, Math.max(0, remaining()), label);
    };
    const safeRecord = (kind, fields) => {
      try { log.record(kind, fields); } catch (err) { throw new LocalError(err.message); }
    };

    const plans = [];
    const skipped = [];
    let stubs = [];
    let code = EXIT.OK;

    try {
      safeRecord('start', { dry_run: dryRun });

      if (!(await bounded(health(base ?? new URL(url).origin, Math.max(0, remaining())), 'health'))) {
        safeRecord('error', { stage: 'preflight', message: 'health check failed' });
        code = EXIT.MCP;
        throw new Error('preflight failed');
      }
      check();

      const client = await bounded(connect({ url, token }), 'connect');
      const rows = await bounded(census(client, censusCap), 'census');
      check();
      safeRecord('census', { count: rows.length });

      const graph = buildGraph(rows);
      for (const e of rows) plans.push(planEntry(e, graph));
      stubs = planStubs(graph);

      const summary = {};
      for (const p of plans) summary[p.disposition] = (summary[p.disposition] || 0) + 1;
      safeRecord('plan', { summary, stubs: stubs.length });
      for (const p of plans) {
        if (p.actions.length || p.flags.length) {
          safeRecord('plan', { id: p.id, disposition: p.disposition, actions: p.actions, flags: p.flags });
        }
      }
      for (const stub of stubs) safeRecord('plan', { id: stub.id, disposition: 'stub', actions: ['stub'] });

      if (!dryRun) {
        for (const p of plans) {
          if (NO_WRITE.has(p.disposition) || !p.write) continue;
          await applyOne(client, p, rows, bounded, safeRecord, skipped);
          check();
        }
        for (const stub of stubs) {
          const operationId = randomUUID();
          safeRecord('intent', { id: stub.id, operation_id: operationId, preimage: null });
          const res = await bounded(
            setEntry(client, { ...stub, if_version: 0, operation_id: operationId }), 'stub-create',
          );
          if (res.ok) safeRecord('applied', { id: stub.id, operation_id: operationId });
          else {
            // A refusal here means the id was explicitly deleted and its revision
            // counter survived. Never resurrect it silently. Transport failures
            // throw from setEntry, so reaching this branch means the server said no.
            safeRecord('rejected', { id: stub.id, operation_id: operationId, reason: res.error });
            skipped.push(`${stub.id}: stub conflict, id was deleted before (${res.error})`);
          }
          check();
        }
      }
    } catch (err) {
      if (err instanceof LocalError) code = EXIT.LOCAL;
      else if (err instanceof DeadlineError) code = EXIT.BUDGET;
      else if (err instanceof TruncatedCensusError) code = EXIT.TRUNCATED;
      else if (code === EXIT.OK) code = EXIT.MCP;
      try { log.record('error', { stage: 'run', message: err.message }); } catch { /* best effort */ }
    }

    // Always attempt a report, even on an aborted run: a truncated or partial
    // pass is exactly when someone needs to see what it did and did not do.
    try {
      writeReport(dir, plans, {
        includeActions: dryRun,
        stubs: dryRun ? stubs.map((s) => s.id) : [],
        Skipped: skipped,
      });
    } catch {
      if (code === EXIT.OK) code = EXIT.LOCAL;
    }

    let landed = 0;
    try {
      landed = log.writesLanded();
    } catch {
      // An unwritable log is a local failure, not a success. Say so rather than
      // returning 0 for a run whose record does not exist.
      if (code === EXIT.OK) code = EXIT.LOCAL;
    }

    // 4 outranks every other non-zero code: an incomplete run that changed the
    // store is a more serious fact than the reason it stopped. Resolved BEFORE
    // the end record is written, so the record and the code `run()` returns
    // always agree: an operator reading the log after an alert must never see
    // a code that contradicts the one that triggered it.
    if (landed > 0 && code !== EXIT.OK) code = EXIT.PARTIAL;

    try {
      log.record('end', { code, counts: log.counts(), writes_landed: landed });
    } catch {
      // Same rule as above: an unwritable log is a local failure, not a
      // success, unless the run already reports something more serious.
      if (code === EXIT.OK) code = EXIT.LOCAL;
    }
    log.close();

    return code;
  } catch {
    try { log?.close(); } catch { /* best effort */ }
    return EXIT.LOCAL;
  }
}

export async function applyOne(client, p, rows, bounded, safeRecord, skipped, store = defaultStore) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const fresh = await bounded(store.getEntry(client, p.id), `get:${p.id}`);
    safeRecord('read', { id: p.id });
    if (!fresh) { skipped.push(`${p.id}: vanished between census and write`); return; }

    // Re-plan against the fresh value. The census is not a snapshot, so an entry
    // hand-edited since then may no longer deserve what was planned for it.
    // `fresh.entry` carries no `revision`, so it is shaped exactly like a census
    // row and can be substituted directly.
    const freshRows = rows.map((r) => (r.id === p.id ? fresh.entry : r));
    const replanned = planEntry(fresh.entry, buildGraph(freshRows));
    if (replanned.disposition !== p.disposition || !replanned.write) {
      safeRecord('skip', { id: p.id, reason: 'eligibility-changed' });
      skipped.push(`${p.id}: changed since census (${p.disposition} -> ${replanned.disposition})`);
      return;
    }

    const operationId = randomUUID();
    safeRecord('intent', { id: p.id, operation_id: operationId, preimage: fresh.entry });
    const res = await bounded(
      store.setEntry(client, { ...replanned.write, if_version: fresh.revision, operation_id: operationId }),
      `set:${p.id}`,
    );

    if (res.ok) {
      safeRecord('applied', { id: p.id, operation_id: operationId, prior_revision: fresh.revision });
      return;
    }
    safeRecord('rejected', { id: p.id, operation_id: operationId, reason: res.error });
  }
  safeRecord('skip', { id: p.id, reason: 'conflict-twice' });
  skipped.push(`${p.id}: two compare-and-set conflicts, skipped`);
}
