/**
 * Runs every declarative storage/LWW scenario of
 * crates/cardo-core/tests/fixtures/sync-v1/conformance against the IndexedDB
 * store, with exactly the expectations crates/cardo-core/tests/conformance.rs
 * applies to SqliteStorage. Format: see the fixtures README.
 */
import 'fake-indexeddb/auto';

import { readdirSync } from 'node:fs';

import type { StorageQuery } from '@cardo/plugin-api';
import { afterEach, describe, expect, it } from 'vitest';

import { createIdbStore, type IdbStore } from './idb/store';
import { deepEqual, stableStringify } from './json';
import { fixturePath, readFixture } from './testing/fixtures';
import type { ChangeNotice } from './types';
import { parseSyncOp } from './wire';

interface Step {
  kind: 'set' | 'delete' | 'get' | 'remote' | 'query' | 'sleep';
  ms?: number;
  namespace?: string;
  id?: string;
  value?: Record<string, unknown>;
  expectOperation?: string;
  expectOpsLogged?: number;
  expectError?: boolean;
  expectDoc?: unknown;
  op?: unknown;
  expect?: 'applied' | 'skipped' | 'error';
  query?: StorageQuery;
  expectRows?: unknown[];
  ordered?: boolean;
}

interface Scenario {
  name: string;
  description: string;
  steps: Step[];
  expectDocs: unknown;
  expectLocalOps: unknown[];
}

const files = readdirSync(fixturePath('conformance'))
  .filter((n) => n.endsWith('.json'))
  .sort();

const stores: IdbStore[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));

const show = (v: unknown) => stableStringify(v ?? null);

function sameRows(got: unknown[], want: unknown[], ordered: boolean): boolean {
  if (ordered) return deepEqual(got, want);
  const a = got.map(show).sort();
  const b = want.map(show).sort();
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Mirrors run_scenario in conformance.rs; returns all mismatches (empty = pass). */
async function runScenario(scenario: Scenario, dbName: string): Promise<string[]> {
  const s = createIdbStore(dbName, { broadcast: false });
  stores.push(s);
  const errors: string[] = [];

  for (const [i, step] of scenario.steps.entries()) {
    const fail = (msg: string) => errors.push(`step ${i} (${step.kind}): ${msg}`);
    const expectError = step.expectError ?? false;
    const ns = step.namespace ?? '';
    const id = step.id ?? '';
    switch (step.kind) {
      case 'set':
      case 'delete': {
        const r = await attempt<ChangeNotice>(() =>
          step.kind === 'set' ? s.write(ns, id, step.value ?? {}) : s.remove(ns, id),
        );
        if (!r.ok) {
          if (!expectError) fail(`unexpected error ${String(r.error)}`);
        } else if (expectError) {
          fail(`expected error, got ${r.value.operation}`);
        } else {
          if (step.kind === 'set' && step.expectOperation && r.value.operation !== step.expectOperation) {
            fail(`operation ${r.value.operation} != ${step.expectOperation}`);
          }
          if (step.expectOpsLogged !== undefined && r.value.ops_logged !== step.expectOpsLogged) {
            fail(`opsLogged ${r.value.ops_logged} != ${step.expectOpsLogged}`);
          }
        }
        break;
      }
      case 'get': {
        const r = await attempt(() => s.get(ns, id));
        if (!r.ok) {
          if (!expectError) fail(`unexpected error ${String(r.error)}`);
        } else if (expectError) {
          fail('expected error');
        } else if (!deepEqual(r.value ?? null, step.expectDoc ?? null)) {
          fail(`doc ${show(r.value)} != ${show(step.expectDoc)}`);
        }
        break;
      }
      case 'remote': {
        // serde's SyncOp deserialization rules (JSON null field/value → None).
        const op = parseSyncOp(JSON.stringify(step.op));
        const r = await attempt(() => s.applyRemoteOp(op));
        const got = !r.ok ? 'error' : r.value ? 'applied' : 'skipped';
        if (got !== step.expect) {
          fail(`op ${op.op_id} → ${got}, expected ${String(step.expect)}`);
        } else if (step.expectOperation && r.ok && r.value?.operation !== step.expectOperation) {
          fail(`notice operation ${String(r.value?.operation)} != ${step.expectOperation}`);
        }
        break;
      }
      case 'query': {
        const q = step.query ?? {};
        const ordered = step.ordered ?? q.orderBy != null;
        const r = await attempt(() => s.query(ns, q));
        if (!r.ok) {
          if (!expectError) fail(`unexpected error ${String(r.error)}`);
        } else if (expectError) {
          fail(`expected error, got ${show(r.value)}`);
        } else if (!sameRows(r.value, step.expectRows ?? [], ordered)) {
          fail(`rows ${show(r.value)} != ${show(step.expectRows)}`);
        }
        break;
      }
      case 'sleep':
        await new Promise((resolve) => setTimeout(resolve, step.ms ?? 0));
        break;
      default:
        throw new Error(`unknown step kind ${String((step as { kind: unknown }).kind)}`);
    }
  }

  const docs = await s.dumpAll();
  if (!deepEqual(docs, scenario.expectDocs)) errors.push(`expectDocs: got ${show(docs)}`);

  // The device's own ops in log order (remote winners are stored synced).
  const deviceId = await s.deviceId();
  const local = (await s.unsyncedOps(1_000_000, [])).map((op) => {
    if (op.device_id !== deviceId) errors.push(`foreign op ${op.op_id} in the local log`);
    return { namespace: op.namespace, docId: op.doc_id, op: op.op, field: op.field, value: op.value };
  });
  if (!deepEqual(local, scenario.expectLocalOps)) errors.push(`expectLocalOps: got ${show(local)}`);
  return errors;
}

describe('sync-v1 conformance scenarios (shared with cardo-core)', () => {
  it('finds the full scenario set', () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  it('the runner really detects mismatches (mutated copies must fail)', async () => {
    const base = readFixture<Scenario>('conformance', files.find((f) => f.startsWith('03')) ?? (files[0] as string));
    const flipped = structuredClone(base);
    const remote = flipped.steps.find((st) => st.kind === 'remote' && st.expect === 'skipped');
    expect(remote).toBeDefined();
    if (remote) remote.expect = 'applied';
    expect(await runScenario(flipped, `conformance-mut1-${Date.now()}`)).not.toEqual([]);

    const docs = structuredClone(base);
    docs.expectDocs = { todo: { nope: {} } };
    docs.expectLocalOps = [...docs.expectLocalOps, { namespace: 'x', docId: 'y', op: 'create', field: null, value: {} }];
    expect(await runScenario(docs, `conformance-mut2-${Date.now()}`)).toHaveLength(2);
  });

  for (const file of files) {
    const scenario = readFixture<Scenario>('conformance', file);
    it(`${scenario.name}`, async () => {
      const errors = await runScenario(scenario, `conformance-${file}-${Date.now()}`);
      expect(errors, scenario.description).toEqual([]);
    });
  }
});
