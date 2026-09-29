import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '@foc/platform';
import type { Database } from '../src/db/db.js';
import * as schema from '../src/db/schema.js';
import { migrations } from '../src/db/migrations.js';
import { loadSeedSuppliers } from '../src/admin/seed-data.js';
import { seedSuppliers } from '../src/admin/seed.js';
import { suppliersRepository as repo } from '../src/suppliers/suppliers.repository.js';
import type { SupplierSeed } from '../src/admin/normalize.js';
import { PgliteDb } from './helpers/pglite-db.js';

// `raw` runs the migrations and backs the direct SQL assertions; `db` is the
// Drizzle handle the seed and repository actually query through — both over the
// same PGlite (mirroring how the service is wired in production).
let raw: PgliteDb;
let db: Database;
let seeds: SupplierSeed[];

beforeAll(async () => {
  seeds = await loadSeedSuppliers();
});
beforeEach(async () => {
  raw = await PgliteDb.create();
  await runMigrations(raw, migrations);
  db = drizzle(raw.client, { schema });
});
afterAll(async () => {
  await raw?.close();
});

const count = async () =>
  Number((await raw.query<{ n: string }>('SELECT count(*) AS n FROM suppliers')).rows[0]!.n);

describe('the seed corpus (SS-FR4.1.1)', () => {
  it('loads every template row without a validation error', async () => {
    // loadSeedSuppliers throws with the file+row named if any row fails to
    // normalize or validate — so reaching here means every row loaded.
    expect(seeds.length).toBeGreaterThanOrEqual(30);
  });

  it('holds ≥30 records across ≥10 buildings and every type', () => {
    const buildings = new Set(seeds.map((s) => s.building));
    const types = new Set(seeds.map((s) => s.type));
    expect(seeds.length).toBeGreaterThanOrEqual(30);
    expect(buildings.size).toBeGreaterThanOrEqual(10);
    expect([...types].sort()).toEqual(['CAFE', 'FOOD', 'LANDMARK', 'PRINTING', 'SHOPPING']);
  });

  it('has no building that appears under two spellings', () => {
    // After normalization each building maps to exactly one canonical string, so
    // the count of distinct display names equals the count of distinct lower-cased,
    // apostrophe-folded keys. Any drift would mean the filter shows a dup.
    const canonical = new Set(seeds.map((s) => s.building));
    const folded = new Set(
      seeds.map((s) => s.building.replace(/[’']/g, "'").replace(/\s+/g, ' ').trim().toLowerCase()),
    );
    expect(canonical.size).toBe(folded.size);
  });

  it('gives every record all required fields, one allowed type and a stable id', () => {
    for (const s of seeds) {
      expect(s.name).toBeTruthy();
      expect(s.building).toBeTruthy();
      expect(s.floor).toBeTruthy();
      expect(s.locationDescription).toBeTruthy();
      expect(['FOOD', 'CAFE', 'PRINTING', 'SHOPPING', 'LANDMARK']).toContain(s.type);
      expect(s.supplierId).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(new Set(seeds.map((s) => s.supplierId)).size).toBe(seeds.length);
  });
});

describe('seedSuppliers (idempotent, stable)', () => {
  it('creates all rows on the first run', async () => {
    const r = await seedSuppliers(db, seeds);
    expect(r.created).toHaveLength(seeds.length);
    expect(r.skipped).toHaveLength(0);
    expect(await count()).toBe(seeds.length);
  });

  it('three consecutive runs keep the same count and identifiers', async () => {
    await seedSuppliers(db, seeds);
    const idsAfterFirst = (
      await raw.query<{ supplier_id: string }>(
        'SELECT supplier_id FROM suppliers ORDER BY supplier_id',
      )
    ).rows;

    const second = await seedSuppliers(db, seeds);
    const third = await seedSuppliers(db, seeds);
    expect(second.created).toHaveLength(0);
    expect(second.skipped).toHaveLength(seeds.length);
    expect(third.created).toHaveLength(0);

    const idsAfterThird = (
      await raw.query<{ supplier_id: string }>(
        'SELECT supplier_id FROM suppliers ORDER BY supplier_id',
      )
    ).rows;
    expect(idsAfterThird).toEqual(idsAfterFirst);
    expect(await count()).toBe(seeds.length);
  });

  it('never overwrites an admin edit made between runs', async () => {
    await seedSuppliers(db, seeds);
    const target = seeds[0]!;
    await raw.query(
      `UPDATE suppliers SET location_description = 'ADMIN EDITED', version = version + 1 WHERE supplier_id = $1`,
      [target.supplierId],
    );

    await seedSuppliers(db, seeds); // a re-run must leave the edit alone
    const row = await repo.findById(db, target.supplierId);
    expect(row?.locationDescription).toBe('ADMIN EDITED');
    expect(row?.version).toBe(2);
  });

  it('leaves a supplier the admin deactivated deactivated on re-run', async () => {
    await seedSuppliers(db, seeds);
    const target = seeds[0]!;
    const seeded = await repo.findById(db, target.supplierId);
    await repo.deactivate(db, target.supplierId, seeded!.version);

    await seedSuppliers(db, seeds);
    const row = await repo.findById(db, target.supplierId);
    expect(row?.active).toBe(false);
    expect(await count()).toBe(seeds.length); // not resurrected as a new row
  });
});
