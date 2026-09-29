export { baseEnvSchema, loadEnv, type BaseEnv } from './env.js';
export {
  CORRELATION_HEADER,
  CAUSATION_HEADER,
  echoCorrelationId,
  resolveCorrelationId,
} from './correlation.js';
export { createLogger, PinoLoggerService, requestLogger } from './logging.js';
export { ApiException, ErrorEnvelopeFilter, type ErrorEnvelope } from './errors.js';
export {
  HealthController,
  SERVICE_INFO,
  type HealthResponse,
  type ServiceInfo,
} from './health.controller.js';
export { LOGGER, PlatformModule, type PlatformModuleOptions } from './platform.module.js';
export { startService } from './bootstrap.js';
export {
  PgDb,
  createPgPool,
  runMigrations,
  type Db,
  type Queryable,
  type Row,
  type Migration,
  type DrizzleDatabase,
} from './db.js';
export * from './events/index.js';
