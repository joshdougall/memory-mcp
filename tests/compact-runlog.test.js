import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunLog, writeReport } from '../compact/runlog.js';

let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'compact-log-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('RunLog', () => {
  it('writes to a log subdirectory named by date', () => {
    const log = new RunLog(dir, new Date('2026-08-13T03:00:00Z'));
    log.close();
    expect(log.path).toBe(join(dir, 'log', '2026-08-13.jsonl'));
    expect(existsSync(log.path)).toBe(true);
  });

  it('appends one json object per line', () => {
    const log = new RunLog(dir);
    log.record('read', { id: 'a' });
    log.record('applied', { id: 'a', operation_id: 'op1' });
    log.close();
    const lines = readFileSync(log.path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[1].kind).toBe('applied');
  });

  it('counts an acknowledged write once', () => {
    const log = new RunLog(dir);
    log.record('intent', { id: 'a', operation_id: 'op1' });
    log.record('applied', { id: 'a', operation_id: 'op1' });
    expect(log.writesLanded()).toBe(1);
    log.close();
  });

  it('counts an unacknowledged intent as landed, conservatively', () => {
    const log = new RunLog(dir);
    log.record('intent', { id: 'a', operation_id: 'op1' });
    expect(log.writesLanded()).toBe(1);
    log.close();
  });

  it('does not count a rejected write', () => {
    const log = new RunLog(dir);
    log.record('intent', { id: 'a', operation_id: 'op1' });
    log.record('rejected', { id: 'a', operation_id: 'op1', reason: 'conflict' });
    expect(log.writesLanded()).toBe(0);
    log.close();
  });

  it('counts the second attempt when the first was rejected', () => {
    const log = new RunLog(dir);
    log.record('intent', { id: 'a', operation_id: 'op1' });
    log.record('rejected', { id: 'a', operation_id: 'op1', reason: 'conflict' });
    log.record('intent', { id: 'a', operation_id: 'op2' });
    log.record('applied', { id: 'a', operation_id: 'op2' });
    expect(log.writesLanded()).toBe(1);
    log.close();
  });

  it('throws rather than recording when the log cannot be persisted', () => {
    const log = new RunLog(dir);
    log.close(); // fd is now closed, so the next write must fail
    expect(() => log.record('intent', { id: 'a', operation_id: 'op1' })).toThrow();
    // and the phantom intent must NOT be counted
    expect(log.writesLanded()).toBe(0);
  });

  it('tallies kinds', () => {
    const log = new RunLog(dir);
    log.record('read', { id: 'a' });
    log.record('read', { id: 'b' });
    log.record('skip', { id: 'c' });
    expect(log.counts()).toMatchObject({ read: 2, skip: 1 });
    log.close();
  });
});

describe('writeReport', () => {
  it('lists flagged entries and omits clean ones', () => {
    const path = writeReport(dir, [
      { id: 'held', disposition: 'hold', flags: ['held-machine-exhaust'], actions: [] },
      { id: 'clean', disposition: 'none', flags: [], actions: [] },
    ]);
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('held');
    expect(text).not.toContain('clean');
  });

  it('lists every intended action and a count tally when asked', () => {
    const path = writeReport(dir, [
      { id: 'x', disposition: 'none', flags: [], actions: ['schema', 'backlinks'] },
      { id: 'y', disposition: 'tombstone', flags: [], actions: ['tombstone'] },
    ], { includeActions: true });
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('schema, backlinks');
    expect(text).toContain('tombstone: 1');
  });

  it('lists proposed stubs when given them', () => {
    const path = writeReport(dir, [], { includeActions: true, stubs: ['ghost-a', 'ghost-b'] });
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('ghost-a');
    expect(text).toContain('upper bound');
  });

  it('is overwritten rather than appended', () => {
    writeReport(dir, [{ id: 'first', disposition: 'hold', flags: ['f'], actions: [] }]);
    const path = writeReport(dir, [{ id: 'second', disposition: 'hold', flags: ['f'], actions: [] }]);
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('second');
    expect(text).not.toContain('first');
  });
});
