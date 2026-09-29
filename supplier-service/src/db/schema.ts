import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { OpeningHours, SupplierType } from '../suppliers/types.js';

/**
 * The Drizzle schema for the suppliers tables — one source of truth for both the
 * query builder (repository) and drizzle-kit (`db:generate`, `db:studio`).
 *
 * The forward-only migrations in `db/migrations.ts` remain the authoritative
 * thing applied at boot, because they also carry objects Drizzle's schema DSL
 * cannot express (nothing here — but see the User Service's audit trigger). This
 * schema is kept in lockstep with them; the CHECK constraints and partial
 * indexes below mirror migration `002`'s final state.
 */
export const suppliers = pgTable(
  'suppliers',
  {
    supplierId: uuid('supplier_id').primaryKey(),
    name: text('name').notNull(),
    // A closed enum, enforced by the database so a bad type cannot slip in
    // through a future code path, not only through the validator (SUP-01).
    type: text('type').notNull().$type<SupplierType>(),
    building: text('building').notNull(),
    floor: text('floor').notNull(),
    locationDescription: text('location_description').notNull(),
    // Per-day opening hours as [{ day, opens, closes }]; see the README.
    openingHours: jsonb('opening_hours').$type<OpeningHours[]>(),
    // Coordinates travel as a pair or not at all (see the CHECKs below).
    latitude: doublePrecision('latitude'),
    longitude: doublePrecision('longitude'),
    imageUrl: text('image_url'),
    tags: jsonb('tags').$type<string[]>(),
    active: boolean('active').notNull().default(true),
    // Optimistic-lock counter. Every update bumps it; a stale If-Match is
    // refused with 412 so a lost update cannot overwrite a newer edit.
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('suppliers_name_len', sql`char_length(${t.name}) BETWEEN 1 AND 200`),
    check(
      'suppliers_type_enum',
      sql`${t.type} IN ('FOOD', 'CAFE', 'PRINTING', 'SHOPPING', 'LANDMARK')`,
    ),
    check('suppliers_building_len', sql`char_length(${t.building}) BETWEEN 1 AND 200`),
    check('suppliers_floor_len', sql`char_length(${t.floor}) BETWEEN 1 AND 50`),
    check('suppliers_location_len', sql`char_length(${t.locationDescription}) BETWEEN 1 AND 500`),
    check(
      'suppliers_image_url_len',
      sql`${t.imageUrl} IS NULL OR char_length(${t.imageUrl}) BETWEEN 1 AND 2048`,
    ),
    check('suppliers_version_positive', sql`${t.version} >= 1`),
    check('suppliers_coordinates_paired', sql`(${t.latitude} IS NULL) = (${t.longitude} IS NULL)`),
    check(
      'suppliers_latitude_range',
      sql`${t.latitude} IS NULL OR ${t.latitude} BETWEEN -90 AND 90`,
    ),
    check(
      'suppliers_longitude_range',
      sql`${t.longitude} IS NULL OR ${t.longitude} BETWEEN -180 AND 180`,
    ),
    // The case-insensitive "name + building" duplicate rule, scoped to active
    // rows only. A deactivated row leaves the name free to be reused.
    uniqueIndex('suppliers_name_building_active_key')
      .on(sql`lower(${t.name})`, sql`lower(${t.building})`)
      .where(sql`active`),
    // Listings only ever read active rows, filtered by type (SUP-02).
    index('suppliers_active_type_idx')
      .on(t.type)
      .where(sql`active`),
  ],
);

/**
 * Retry safety (SUP-01): a create may carry an Idempotency-Key, remembered here
 * with the supplier it produced and the hash of the body that first claimed it.
 */
export const supplierIdempotencyKeys = pgTable('supplier_idempotency_keys', {
  idempotencyKey: text('idempotency_key').primaryKey(),
  supplierId: uuid('supplier_id')
    .notNull()
    .references(() => suppliers.supplierId, { onDelete: 'cascade' }),
  requestHash: text('request_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
