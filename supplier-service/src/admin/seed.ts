import type { Database } from '../db/db.js';
import {
  isUniqueViolation,
  suppliersRepository as repo,
} from '../suppliers/suppliers.repository.js';
import type { SupplierSeed } from './normalize.js';

export interface SeedResult {
  created: string[];
  skipped: string[];
}

/**
 * Loads the campus supplier catalogue (SUP-01). Idempotent and stable: each
 * supplier's id is derived from its name+building, so a row inserted once is
 * skipped on every later run — three runs produce the same rows and ids, and an
 * admin's later edits are never overwritten. Each insert is its own transaction,
 * so one skipped row cannot roll back the rest.
 *
 * Data source: FoC template `data/csv/supplier-seed-data.csv` (CS3219-AY2627S1
 * FoC-Template), plus `data/csv/supplier-seed-additions.csv` (this team's
 * additions). See `supplier-service/README.md` for attribution.
 */
export async function seedSuppliers(db: Database, suppliers: SupplierSeed[]): Promise<SeedResult> {
  const result: SeedResult = { created: [], skipped: [] };
  for (const supplier of suppliers) {
    const label = `${supplier.name} @ ${supplier.building}`;
    try {
      const row = await db.transaction((tx) => repo.insertIfAbsent(tx, supplier));
      (row ? result.created : result.skipped).push(label);
    } catch (err) {
      // A different supplier already holds this active name+building: leave the
      // existing row alone and record the skip rather than aborting the seed.
      if (isUniqueViolation(err)) {
        result.skipped.push(label);
        continue;
      }
      throw err;
    }
  }
  return result;
}
