import type { Queryable } from '../db/db.js';
import type { SupplierInput, SupplierRow } from './types.js';

/** Postgres error code for a unique-constraint violation, shared by `pg` and PGlite. */
export const UNIQUE_VIOLATION = '23505';

export const isUniqueViolation = (err: unknown, constraint?: string): boolean => {
  const e = err as { code?: string; constraint?: string } | null;
  if (!e || e.code !== UNIQUE_VIOLATION) return false;
  return constraint ? e.constraint === constraint : true;
};

/** A record ready to store: the validated input plus its stable primary key. */
export interface NewSupplier extends SupplierInput {
  supplierId: string;
}

/** Columns an update may set, in the fixed camel→snake map. Values never come from input keys. */
const UPDATABLE = {
  name: { column: 'name', json: false },
  type: { column: 'type', json: false },
  building: { column: 'building', json: false },
  floor: { column: 'floor', json: false },
  locationDescription: { column: 'location_description', json: false },
  openingHours: { column: 'opening_hours', json: true },
  latitude: { column: 'latitude', json: false },
  longitude: { column: 'longitude', json: false },
  imageUrl: { column: 'image_url', json: false },
  tags: { column: 'tags', json: true },
} as const;

const jsonParam = (value: unknown): string | null =>
  value === null || value === undefined ? null : JSON.stringify(value);

/**
 * All SQL for the suppliers tables. Every function takes a {@link Queryable} so
 * the service can run several of them in one transaction.
 */
// The supplier insert, shared by the plain and insert-if-absent variants so the
// column list, placeholders and params stay in lockstep — add a column once.
const INSERT_COLUMNS =
  'supplier_id, name, type, building, floor, location_description, opening_hours, latitude, longitude, image_url, tags';
const INSERT_VALUES = '$1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11::jsonb';

const insertParams = (s: NewSupplier): unknown[] => [
  s.supplierId,
  s.name,
  s.type,
  s.building,
  s.floor,
  s.locationDescription,
  jsonParam(s.openingHours ?? null),
  s.latitude ?? null,
  s.longitude ?? null,
  s.imageUrl ?? null,
  jsonParam(s.tags ?? null),
];

export const suppliersRepository = {
  /** Inserts a supplier. Throws the unique violation on an active name+building clash. */
  async insert(q: Queryable, s: NewSupplier): Promise<SupplierRow> {
    const { rows } = await q.query<SupplierRow>(
      `INSERT INTO suppliers (${INSERT_COLUMNS})
       VALUES (${INSERT_VALUES})
       RETURNING *`,
      insertParams(s),
    );
    return rows[0]!;
  },

  /** Insert-if-absent, keyed on the stable primary key. Returns the row only when it was created. */
  async insertIfAbsent(q: Queryable, s: NewSupplier): Promise<SupplierRow | null> {
    const { rows } = await q.query<SupplierRow>(
      `INSERT INTO suppliers (${INSERT_COLUMNS})
       VALUES (${INSERT_VALUES})
       ON CONFLICT (supplier_id) DO NOTHING
       RETURNING *`,
      insertParams(s),
    );
    return rows[0] ?? null;
  },

  /** A single supplier by id, active or not — a deactivated supplier stays resolvable. */
  async findById(q: Queryable, id: string): Promise<SupplierRow | null> {
    const { rows } = await q.query<SupplierRow>(`SELECT * FROM suppliers WHERE supplier_id = $1`, [
      id,
    ]);
    return rows[0] ?? null;
  },

  /** Active suppliers only, for listings (SUP-02 adds filter/sort/pagination on top). */
  async listActive(q: Queryable): Promise<SupplierRow[]> {
    const { rows } = await q.query<SupplierRow>(
      `SELECT * FROM suppliers WHERE active ORDER BY name, building`,
    );
    return rows;
  },

  /**
   * Applies only the fields present, bumping the version and `updated_at`, but
   * only if the row is still at `expectedVersion`. Returns the new row, or null
   * if the version did not match (a stale edit) or the row does not exist.
   */
  async update(
    q: Queryable,
    id: string,
    expectedVersion: number,
    changes: Partial<SupplierInput>,
  ): Promise<SupplierRow | null> {
    const sets: string[] = ['version = version + 1', 'updated_at = now()'];
    const params: unknown[] = [id, expectedVersion];
    for (const [key, meta] of Object.entries(UPDATABLE)) {
      if (!(key in changes)) continue;
      const value = changes[key as keyof SupplierInput];
      params.push(meta.json ? jsonParam(value) : (value ?? null));
      sets.push(`${meta.column} = $${params.length}${meta.json ? '::jsonb' : ''}`);
    }
    const { rows } = await q.query<SupplierRow>(
      `UPDATE suppliers SET ${sets.join(', ')}
       WHERE supplier_id = $1 AND version = $2
       RETURNING *`,
      params,
    );
    return rows[0] ?? null;
  },

  /**
   * Soft-deactivates an active supplier at `expectedVersion`, bumping the
   * version. Returns the row, or null if it did not match — i.e. the row is
   * missing, already inactive, or at a different version. The service reads the
   * row back to tell those cases apart (idempotent no-op vs. 404 vs. 412).
   */
  async deactivate(q: Queryable, id: string, expectedVersion: number): Promise<SupplierRow | null> {
    const { rows } = await q.query<SupplierRow>(
      `UPDATE suppliers SET active = false, version = version + 1, updated_at = now()
       WHERE supplier_id = $1 AND version = $2 AND active
       RETURNING *`,
      [id, expectedVersion],
    );
    return rows[0] ?? null;
  },

  /**
   * The prior result for an Idempotency-Key: the supplier it produced and the
   * hash of the request body that claimed it, so the service can replay a
   * matching request but reject a reused key carrying a different body.
   */
  async findIdempotent(
    q: Queryable,
    key: string,
  ): Promise<{ supplierId: string; requestHash: string } | null> {
    const { rows } = await q.query<{ supplier_id: string; request_hash: string }>(
      `SELECT supplier_id, request_hash FROM supplier_idempotency_keys WHERE idempotency_key = $1`,
      [key],
    );
    const row = rows[0];
    return row ? { supplierId: row.supplier_id, requestHash: row.request_hash } : null;
  },

  /** Claims a key for a supplier, storing the request hash. Returns false if another request already claimed it. */
  async claimIdempotencyKey(
    q: Queryable,
    key: string,
    supplierId: string,
    requestHash: string,
  ): Promise<boolean> {
    const { rows } = await q.query(
      `INSERT INTO supplier_idempotency_keys (idempotency_key, supplier_id, request_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING idempotency_key`,
      [key, supplierId, requestHash],
    );
    return rows.length > 0;
  },
};
