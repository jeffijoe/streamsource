import {
  createPostgresStreamStoreBootstrapper,
  PgStreamStoreConfig
} from '../postgres'
import { createConsoleLogger } from '../logging/console'

const cmd = process.argv[2]

if (!cmd) {
  printHelp()
} else {
  runCommand(cmd).catch(_e => {
    /**/
  })
}

async function runCommand(cmd: string) {
  const logger = createConsoleLogger(
    getArg('verbose', 'false') !== 'false' ? 'trace' : 'info'
  )
  const cfg: PgStreamStoreConfig = {
    logger,
    pg: {
      host: getArg('host', 'localhost'),
      port: getArg('port', '5432'),
      database: getArg('db', 'streamsource'),
      schema: getArg('schema', 'streamsource'),
      user: getArg('user', 'postgres'),
      password: getArg('pass', '')
    }
  }
  const bootstrapper = createPostgresStreamStoreBootstrapper(cfg)
  switch (cmd) {
    case 'setup':
      return bootstrapper
        .bootstrap()
        .then(() => logger.info('StreamSource database is ready.'))
    case 'teardown':
      return bootstrapper
        .teardown()
        .then(() =>
          logger.info(
            'StreamSource tables, indexes and types have been dropped.'
          )
        )
    case 'help':
      return printHelp()
    default:
      logger.error(
        `Unknown command "${cmd}" — the first value passed to this tool must be the command`
      )
  }
}

/**
 * Quick and dirty way to grab an option or a default value.
 *
 * @param name
 * @param defaultValue
 */
function getArg(name: string, defaultValue: string) {
  const arg = process.argv.find(x => x.startsWith('--' + name))
  if (!arg) {
    return defaultValue
  }
  const eqIdx = arg.indexOf('=')
  if (eqIdx < 0) {
    return defaultValue
  }

  const value = arg.substring(eqIdx + 1)
  return value || defaultValue
}

// prettier-ignore
function printHelp() {
  console.log('StreamSource Postgres management tool\n')
  console.log('Global options:')
  console.log('  --verbose                   Log more stuff')
  console.log()
  console.log('Available commands:\n')
  console.log('  setup                       Sets up a database with the right tables and such. Arguments:')
  console.log('    --host=localhost          The PG server host to use')
  console.log('    --port=5432               The PG server port to use')
  console.log('    --user=postgres           The PG user to authenticate as')
  console.log('    --pass=                   The PG user password')
  console.log('    --db=streamsource         The database to create or modify')
  console.log('    --schema=streamsource     The schema to use. I recommend specifying one over using public.')
  console.log()
  console.log('  teardown                    Deletes the StreamSource tables and data. Same arguments as setup.')
}
