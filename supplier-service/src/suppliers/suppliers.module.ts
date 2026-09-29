import { Module, type DynamicModule } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import { createPgPool } from '@foc/platform';
import { env } from '../config.js';
import { DB } from '../db/db.js';
import * as schema from '../db/schema.js';
import { SuppliersController } from './suppliers.controller.js';
import { SuppliersService } from './suppliers.service.js';

@Module({})
export class SuppliersModule {
  static forRoot(): DynamicModule {
    return {
      module: SuppliersModule,
      controllers: [SuppliersController],
      providers: [
        SuppliersService,
        // A Drizzle instance over a `pg` pool. Tests override DB with a
        // PGlite-backed Drizzle instance built the same way.
        { provide: DB, useFactory: () => drizzle(createPgPool(env.DATABASE_URL), { schema }) },
      ],
      exports: [DB, SuppliersService],
    };
  }
}
