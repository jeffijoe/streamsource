import { PgStreamStoreConfig } from '../types/config'
import * as schemaV1 from './schema-v1'
import * as queryUtil from '../utils/query-util'
import { createPostgresPool, runInTransaction } from '../connection'
import format from 'pg-format'
import { noopLogger } from '../../logging/noop'

/**
 * Bootstrapper for the Postgres Stream Store.
 *
 * @param config
 */
export function createPostgresStreamStoreBootstrapper(
  config: PgStreamStoreConfig
) {
  const logger = config.logger || /* istanbul ignore next */ noopLogger
  const replaceSchema = (str: string) =>
    queryUtil.replaceSchema(str, config.pg.schema)
  return {
    /**
     * Bootstraps the Stream Store database.
     */
    bootstrap() {
      return dropDatabaseIfTest()
        .then(() => createDbIfNotExist())
        .then(() => setupPostgresSchema())
        .catch(
          /* istanbul ignore next */
          err => {
            logger.error(err)
            throw err
          }
        )
    },

    /**
     * Tears down the database schema.
     */
    teardown() {
      return dropPostgresSchema()
    }
  }

  /**
   * Creates a database if it does not exist
   *
   * @param db Database name.
   * @param user Database user to create.
   */
  /* istanbul ignore next */
  async function createDbIfNotExist() {
    const { database: db } = config.pg
    const pool = createPostgresPool({
      ...config.pg,
      database: 'postgres'
    })
    try {
      await pool
        .query(format(`CREATE DATABASE %I`, db))
        .catch(ignoreErrorIfExists)
    } finally {
      await pool.end()
    }
  }

  /**
   * Sets up the Postgres schema.
   */
  async function setupPostgresSchema() {
    const pool = createPostgresPool(config.pg)
    try {
      await runInTransaction(pool, trx => {
        const sql = replaceSchema(schemaV1.SETUP_SQL)
        return trx.query(sql)
      }).catch(ignoreErrorIfExists)
    } finally {
      await pool.end()
    }
  }

  /**
   * Drops the database if it's a test database and we're in test mode.
   */
  /* istanbul ignore next */
  async function dropDatabaseIfTest() {
    const db = config.pg.database
    if (!config.pg.dropIfTest || db.endsWith('_test') === false) {
      return
    }

    const pool = createPostgresPool({
      ...config.pg,
      database: 'postgres'
    })
    try {
      const CLOSE_CONNS_SQL = format(
        `SELECT pg_terminate_backend(pg_stat_activity.pid)
        FROM pg_stat_activity
        WHERE pg_stat_activity.datname = %L AND pid <> pg_backend_pid()`,
        db
      )

      // Disconnect clients
      await pool.query(CLOSE_CONNS_SQL)

      await pool.query(format('drop database %I', db)).catch((err: Error) => {
        if (err.message.includes('does not exist')) {
          return
        }
        throw err
      })

      logger.debug(`Dropped database ${db} because drop: true`)
    } finally {
      await pool.end()
    }
  }

  /**
   * Drops the Postgres schema.
   */
  async function dropPostgresSchema() {
    const pool = createPostgresPool(config.pg)
    try {
      await runInTransaction(pool, trx => {
        const sql = replaceSchema(schemaV1.TEARDOWN_SQL)
        return trx.query(sql)
      }).catch(ignoreErrorIfNotExists)
    } finally {
      await pool.end()
    }
  }

  /**
   * If the error is a "already exists" error, just ignore it.
   *
   * @param err
   */
  /* istanbul ignore next */
  function ignoreErrorIfExists(err: Error) {
    if (err.message.indexOf('already exists') > -1) {
      return
    }
    throw err
  }

  /**
   * If the error is a "does not exist" error, just ignore it.
   *
   * @param err
   */
  /* istanbul ignore next */
  function ignoreErrorIfNotExists(err: Error) {
    if (err.message.indexOf('does not exist') > -1) {
      return
    }
    throw err
  }
}
