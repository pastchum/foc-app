import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { ApiException } from '@foc/platform';
import { DB, type Database } from '../db/db.js';
import { isUniqueViolation, suppliersRepository as repo } from './suppliers.repository.js';
import { validationFailed } from './validation.js';
import { toSupplierView, type SupplierInput, type SupplierView } from './types.js';

const NAME_BUILDING_INDEX = 'suppliers_name_building_active_key';

const notFound = () => new ApiException(404, 'NOT_FOUND', 'Supplier not found.');

/**
 * A stable SHA-256 over the validated create input, with object keys sorted so
 * two logically-equal bodies (fields in any order) hash the same. Used to
 * detect an Idempotency-Key replayed with a *different* body.
 */
const requestHash = (input: SupplierInput): string => {
  const canonical = JSON.stringify(input, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  );
  return createHash('sha256').update(canonical).digest('hex');
};

/** An Idempotency-Key reused with a body that differs from the first request. */
const idempotencyKeyReused = () =>
  new ApiException(
    422,
    'IDEMPOTENCY_KEY_REUSED',
    'This Idempotency-Key was already used for a request with a different body.',
  );

/** The active name+building clash surfaces as a field-level 422, like any other validation error. */
const duplicate = () =>
  validationFailed([
    {
      field: 'name',
      code: 'DUPLICATE_NAME_BUILDING',
      message: 'An active supplier with this name already exists in this building.',
    },
  ]);

export interface CreateResult {
  supplier: SupplierView;
  /** True when an Idempotency-Key replay returned the original supplier rather than creating one. */
  replayed: boolean;
}

/**
 * Supplier catalogue operations (SUP-01). Every mutation runs in one
 * transaction, so a row commits fully or not at all: a failure leaves nothing
 * half-written and surfaces through the shared error envelope.
 */
@Injectable()
export class SuppliersService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async list(): Promise<SupplierView[]> {
    const rows = await repo.listActive(this.db);
    return rows.map(toSupplierView);
  }

  async getById(id: string): Promise<SupplierView> {
    const row = await repo.findById(this.db, id);
    if (!row) throw notFound();
    return toSupplierView(row);
  }

  async create(input: SupplierInput, idempotencyKey?: string): Promise<CreateResult> {
    // Bind the key to the exact body that first used it. A replay with the same
    // body returns the original supplier; a reused key with a different body is
    // a caller error (422) rather than a silent replay of the wrong supplier.
    // Follow-up: keys are global and never expire — user-scoping and TTL are
    // intentionally out of scope here (tracked separately).
    const hash = idempotencyKey ? requestHash(input) : undefined;

    return this.db.transaction(async (tx) => {
      if (idempotencyKey) {
        // Serialize same-key requests so a concurrent replay waits for the first
        // to commit, then finds its result below instead of racing to insert.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${idempotencyKey}))`);
        const existing = await repo.findIdempotent(tx, idempotencyKey);
        if (existing) {
          if (existing.requestHash !== hash) throw idempotencyKeyReused();
          const row = await repo.findById(tx, existing.supplierId);
          return { supplier: toSupplierView(row!), replayed: true };
        }
      }

      const supplierId = randomUUID();
      let row;
      try {
        row = await repo.insert(tx, { supplierId, ...input });
      } catch (err) {
        if (isUniqueViolation(err, NAME_BUILDING_INDEX)) throw duplicate();
        throw err;
      }

      if (idempotencyKey) {
        await repo.claimIdempotencyKey(tx, idempotencyKey, supplierId, hash!);
      }
      return { supplier: toSupplierView(row), replayed: false };
    });
  }

  async update(
    id: string,
    expectedVersion: number,
    changes: Partial<SupplierInput>,
  ): Promise<SupplierView> {
    const row = await this.db.transaction(async (tx) => {
      let updated;
      try {
        updated = await repo.update(tx, id, expectedVersion, changes);
      } catch (err) {
        if (isUniqueViolation(err, NAME_BUILDING_INDEX)) throw duplicate();
        throw err;
      }
      if (updated) return updated;
      // Nothing updated: tell a missing supplier apart from a stale version, so
      // the caller knows whether to reload or to stop.
      const current = await repo.findById(tx, id);
      if (!current) throw notFound();
      throw new ApiException(
        412,
        'STALE_VERSION',
        `The supplier has changed since version ${expectedVersion}. Reload it and retry.`,
      );
    });
    return toSupplierView(row);
  }

  /**
   * Soft deactivation (SUP-01): the row stays fetchable by id but leaves
   * listings. Versioned like {@link update} — a stale `expectedVersion` is
   * refused with 412 so a stale view cannot delete a newer supplier. Idempotent:
   * if the version matches but the row is already inactive, it is returned
   * unchanged rather than erroring.
   */
  async deactivate(id: string, expectedVersion: number): Promise<SupplierView> {
    const row = await this.db.transaction(async (tx) => {
      const deactivated = await repo.deactivate(tx, id, expectedVersion);
      if (deactivated) return deactivated;
      // Nothing deactivated: distinguish a missing supplier, an already-inactive
      // row at the expected version (idempotent no-op), and a stale version.
      const current = await repo.findById(tx, id);
      if (!current) throw notFound();
      if (!current.active && current.version === expectedVersion) {
        return current; // already inactive at the version the caller holds — no error
      }
      throw new ApiException(
        412,
        'STALE_VERSION',
        `The supplier has changed since version ${expectedVersion}. Reload it and retry.`,
      );
    });
    return toSupplierView(row);
  }
}
