import { and, eq, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import type { Database } from '../db/db.js';
import { suppliers, supplierIdempotencyKeys } from '../db/schema.js';
import type { SupplierInput, SupplierRow } from './types.js';

/** Postgres error code for a unique-constraint violation, shared by `pg` and PGlite. */
export const UNIQUE_VIOLATION = '23505';

/**
 * Drizzle wraps a failed query in a `DrizzleQueryError`, carrying the original
 * driver error (with its `code` and `constraint`) on `.cause`; older/raw paths
 * may throw the driver error directly. Check both so a unique violation is
 * recognised either way.
 */
export const isUniqueViolation = (err: unknown, constraint?: string): boolean => {
  const driver = (err as { cause?: unknown })?.cause ?? err;
  const e = driver as { code?: string; constraint?: string } | null;
  if (!e || e.code !== UNIQUE_VIOLATION) return false;
  return constraint ? e.constraint === constraint : true;
};

/** A record ready to store: the validated input plus its stable primary key. */
export interface NewSupplier extends SupplierInput {
  supplierId: string;
}

/** Columns an update may set. Keys come from this fixed list, never from input keys. */
const UPDATABLE_KEYS = [
  'name',
  'type',
  'building',
  'floor',
  'locationDescription',
  'openingHours',
  'latitude',
  'longitude',
  'imageUrl',
  'tags',
] as const satisfies readonly (keyof SupplierInput)[];

/** Maps a validated input to the row Drizzle inserts (jsonb columns are serialized for us). */
const insertValues = (s: NewSupplier): typeof suppliers.$inferInsert => ({
  supplierId: s.supplierId,
  name: s.name,
  type: s.type,
  building: s.building,
  floor: s.floor,
  locationDescription: s.locationDescription,
  openingHours: s.openingHours ?? null,
  latitude: s.latitude ?? null,
  longitude: s.longitude ?? null,
  imageUrl: s.imageUrl ?? null,
  tags: s.tags ?? null,
});

/**
 * All SQL for the suppliers tables, expressed through Drizzle. Every function
 * takes a {@link Database} — the top-level instance or a transaction handle — so
 * the service can run several of them in one transaction.
 */
export const suppliersRepository = {
  /** Inserts a supplier. Throws the unique violation on an active name+building clash. */
  async insert(db: Database, s: NewSupplier): Promise<SupplierRow> {
    const rows = await db.insert(suppliers).values(insertValues(s)).returning();
    return rows[0]!;
  },

  /** Insert-if-absent, keyed on the stable primary key. Returns the row only when it was created. */
  async insertIfAbsent(db: Database, s: NewSupplier): Promise<SupplierRow | null> {
    const rows = await db
      .insert(suppliers)
      .values(insertValues(s))
      .onConflictDoNothing({ target: suppliers.supplierId })
      .returning();
    return rows[0] ?? null;
  },

  /** A single supplier by id, active or not — a deactivated supplier stays resolvable. */
  async findById(db: Database, id: string): Promise<SupplierRow | null> {
    const rows = await db.select().from(suppliers).where(eq(suppliers.supplierId, id));
    return rows[0] ?? null;
  },

  /** Active suppliers only, for listings (SUP-02 adds filter/sort/pagination on top). */
  async listActive(db: Database): Promise<SupplierRow[]> {
    return db
      .select()
      .from(suppliers)
      .where(eq(suppliers.active, true))
      .orderBy(suppliers.name, suppliers.building);
  },

  /**
   * Applies only the fields present, bumping the version and `updated_at`, but
   * only if the row is still at `expectedVersion`. Returns the new row, or null
   * if the version did not match (a stale edit) or the row does not exist.
   */
  async update(
    db: Database,
    id: string,
    expectedVersion: number,
    changes: Partial<SupplierInput>,
  ): Promise<SupplierRow | null> {
    const set: PgUpdateSetSource<typeof suppliers> = {
      version: sql`${suppliers.version} + 1`,
      updatedAt: sql`now()`,
    };
    for (const key of UPDATABLE_KEYS) {
      // `in` (not a truthiness check) so an explicit null still clears a column.
      if (key in changes) (set as Record<string, unknown>)[key] = changes[key] ?? null;
    }
    const rows = await db
      .update(suppliers)
      .set(set)
      .where(and(eq(suppliers.supplierId, id), eq(suppliers.version, expectedVersion)))
      .returning();
    return rows[0] ?? null;
  },

  /**
   * Soft-deactivates an active supplier at `expectedVersion`, bumping the
   * version. Returns the row, or null if it did not match — i.e. the row is
   * missing, already inactive, or at a different version. The service reads the
   * row back to tell those cases apart (idempotent no-op vs. 404 vs. 412).
   */
  async deactivate(db: Database, id: string, expectedVersion: number): Promise<SupplierRow | null> {
    const rows = await db
      .update(suppliers)
      .set({ active: false, version: sql`${suppliers.version} + 1`, updatedAt: sql`now()` })
      .where(
        and(
          eq(suppliers.supplierId, id),
          eq(suppliers.version, expectedVersion),
          eq(suppliers.active, true),
        ),
      )
      .returning();
    return rows[0] ?? null;
  },

  /**
   * The prior result for an Idempotency-Key: the supplier it produced and the
   * hash of the request body that claimed it, so the service can replay a
   * matching request but reject a reused key carrying a different body.
   */
  async findIdempotent(
    db: Database,
    key: string,
  ): Promise<{ supplierId: string; requestHash: string } | null> {
    const rows = await db
      .select({
        supplierId: supplierIdempotencyKeys.supplierId,
        requestHash: supplierIdempotencyKeys.requestHash,
      })
      .from(supplierIdempotencyKeys)
      .where(eq(supplierIdempotencyKeys.idempotencyKey, key));
    return rows[0] ?? null;
  },

  /** Claims a key for a supplier, storing the request hash. Returns false if another request already claimed it. */
  async claimIdempotencyKey(
    db: Database,
    key: string,
    supplierId: string,
    requestHash: string,
  ): Promise<boolean> {
    const rows = await db
      .insert(supplierIdempotencyKeys)
      .values({ idempotencyKey: key, supplierId, requestHash })
      .onConflictDoNothing({ target: supplierIdempotencyKeys.idempotencyKey })
      .returning({ idempotencyKey: supplierIdempotencyKeys.idempotencyKey });
    return rows.length > 0;
  },
};
