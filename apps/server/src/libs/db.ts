import type { Env } from './env'

import pg from 'pg'

import { useLogger } from '@guiiai/logg'
import { migrate } from '@proj-airi/drizzle-orm-browser-migrator/pg'
import { migrations } from '@proj-airi/server-schema'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'

import * as fullSchema from '../schemas'

const logger = useLogger('db')

export type Database = ReturnType<typeof createDrizzle>['db']

type DrizzleEnv = Pick<Env, 'DATABASE_URL' | 'DB_POOL_MAX' | 'DB_POOL_IDLE_TIMEOUT_MS' | 'DB_POOL_CONNECTION_TIMEOUT_MS' | 'DB_POOL_KEEPALIVE_INITIAL_DELAY_MS'>

// NOTICE: pg is imported statically here. The OTEL instrumentation hooks are
// registered via --import ./instrumentation.mjs (preload) which runs before
// tsx loads application modules, allowing require-in-the-middle to patch pg.
export function createDrizzle(env: DrizzleEnv) {
  const pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: env.DB_POOL_MAX,
    idleTimeoutMillis: env.DB_POOL_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: env.DB_POOL_CONNECTION_TIMEOUT_MS,
    keepAlive: true,
    keepAliveInitialDelayMillis: env.DB_POOL_KEEPALIVE_INITIAL_DELAY_MS,
  })

  pool.on('error', (err) => {
    logger.withError(err).error('Unexpected pool error on idle client')
  })

  const db = drizzle(pool, { schema: fullSchema })
  return { db, pool }
}

export async function migrateDatabase(db: Database) {
  const accountRow = await db.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'account'
    ) AS x
  `)
  const accountExists = Boolean(accountRow.rows[0]?.x)

  const journalTableRow = await db.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations'
    ) AS x
  `)
  let journalRowCount = 0
  if (journalTableRow.rows[0]?.x) {
    const cnt = await db.execute(sql`SELECT COUNT(*)::int AS c FROM drizzle.__drizzle_migrations`)
    journalRowCount = Number(cnt.rows[0]?.c ?? 0)
  }

  if (accountExists && journalRowCount === 0) {
    logger
      .withFields({ journalRowCount, accountExists })
      .error(
        'Refusing to apply SQL migrations: existing tables but drizzle.__drizzle_migrations is empty. '
        + 'Do not mix drizzle-kit push with migrator-only startups on the same database.',
      )
    throw new Error(
      'Database schema drift: `public` tables exist (e.g. account) but `drizzle.__drizzle_migrations` has no rows. '
      + 'The server only applies bundled SQL migrations; an empty journal means every migration would re-run and fail with duplicate_table (42P07). '
      + 'Reset this database (e.g. `docker compose -f apps/server/docker-compose.yml down -v` then `up -d db redis`) or drop/recreate the schema, '
      + 'then restart. See apps/server/README.md.',
    )
  }

  return migrate(db, migrations)
}
