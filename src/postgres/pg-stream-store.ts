import { retry } from 'fejl'
import BigInteger from 'big-integer'
import {
  StreamStore,
  ReadStreamResult,
  AppendToStreamResult,
  ReadAllResult,
  ReadDirection,
  StreamMetadataResult,
  SetStreamMetadataResult,
  SetStreamMetadataOptions,
  ExpectedVersion
} from '../types/stream-store'
import {
  ConcurrencyError,
  InconsistentStreamTypeError,
  DuplicateMessageError,
  DisposedError,
  InvalidParameterError
} from '../errors/errors'
import {
  StreamStoreNotifier,
  MessageProcessor,
  StreamSubscriptionOptions,
  StreamSubscription,
  Subscription,
  SubscriptionOptions,
  AllSubscriptionOptions,
  AllSubscription
} from '../types/subscriptions'
import {
  NewStreamMessage,
  StreamVersion,
  StreamMessage,
  MessagePosition,
  Position
} from '../types/messages'
import { PgStreamStoreConfig } from './types/config'
import { createPostgresPool, runInTransaction } from './connection'
import { createDuplexLatch } from '../utils/latch'
import * as invariant from '../utils/invariant'
import { createStreamSubscription } from '../subscriptions/stream-subscription'
import { noopLogger } from '../logging/noop'
import { createPollingNotifier } from '../subscriptions/polling-notifier'
import { createScripts } from './scripts'
import { createAllSubscription } from '../subscriptions/all-subscription'
import { detectGapsAndReloadAll } from '../utils/gap-detection'
import { v4 } from 'uuid'
import { createPostgresNotifier } from './pg-notifications-notifier'

/**
 * Postgres Stream Store.
 */
export interface PgStreamStore extends StreamStore {}

/**
 * Max bigint value.
 */
const MAX_BIG_VALUE = BigInteger('9223372036854775807').toString()

/**
 * Creates the Postgres Stream Store.
 * @param config
 */
export function createPostgresStreamStore(
  config: PgStreamStoreConfig
): PgStreamStore {
  const logger = config.logger || noopLogger
  const gapReloadDelay =
    config.gapReloadDelay || /* istanbul ignore next */ 5000
  const gapReloadTimes = config.gapReloadTimes || /* istanbul ignore next */ 1
  const notifierConfig = config.notifierConfig || {
    type: 'poll'
  }

  const pool = createPostgresPool(config.pg)
  const scripts = createScripts(config.pg.schema)

  // Keep track of subscriptions so we can dispose them when the store is disposed.
  let _subscriptions: Subscription[] = []
  // Cache the notifier.
  let _notifier: StreamStoreNotifier = null!
  // These 2 are used to ensure that we wait for writes to finish when
  // disposing, and ensure that writes don't happen while disposing.
  let _disposing = false
  const _writeLatch = createDuplexLatch()

  const store: StreamStore = {
    appendToStream,
    readHeadPosition,
    readAll,
    readStream,
    getStreamMetadata,
    setStreamMetadata,
    subscribeToStream,
    subscribeToAll,
    dispose
  }

  return store

  /**
   * Appends to a stream.
   * Creates it if it does not exist.
   *
   * @param streamId
   * @param streamType
   * @param expectedVersion
   * @param newMessages
   */
  async function appendToStream(
    streamId: string,
    expectedVersion: StreamVersion,
    newMessages: NewStreamMessage[]
  ): Promise<AppendToStreamResult> {
    invariant.requiredString('streamId', streamId)
    invariant.required('expectedVersion', expectedVersion)
    invariant.required('newMessages', newMessages)
    newMessages.forEach((m, i) => {
      invariant.required(`newMessages[${i}].messageId`, m.messageId)
      invariant.uuid(`newMessages[${i}].messageId`, m.messageId)
      invariant.required(`newMessages[${i}].type`, m.type)
      invariant.required(`newMessages[${i}].data`, m.data)
    })

    // Retried in case of concurrency issues.
    const retryableAppendToStream = async (again: Function) => {
      try {
        const { current_version, current_position } = await insertMessages(
          streamId,
          expectedVersion,
          newMessages
        )

        throwIfErrorCode(current_version)

        return {
          streamPosition: current_position,
          streamVersion: current_version
        }
      } catch (error) {
        if (isConcurrencyUniqueConstraintViolation(error)) {
          // tslint:disable-next-line:no-ex-assign
          error = new ConcurrencyError()
          /* istanbul ignore else */
          if (expectedVersion === ExpectedVersion.Any) {
            throw again(error)
          }
        } else if (isDuplicateMessageIdUniqueConstraintViolation(error)) {
          throw new DuplicateMessageError(
            extractUuidKeyFromConstraintViolationError(error)
          )
        }
        throw error
      }
    }

    if (_disposing) {
      throw new DisposedError(
        'The stream store has been disposed and is not accepting writes.'
      )
    }

    _writeLatch.enter()
    try {
      return await retry(retryableAppendToStream, {
        factor: 1.05,
        tries: 200,
        minTimeout: 0,
        maxTimeout: 50
      })
    } finally {
      _writeLatch.exit()
    }
  }

  /**
   * Reads the head position.
   */
  async function readHeadPosition(): Promise<string> {
    const result = await pool.query(scripts.readHeadPosition)
    return result.rows[0].pos || '0'
  }

  /**
   * Streams a stream.
   *
   * @param streamId
   * @param fromVersionInclusive
   * @param count
   */
  async function readStream(
    streamId: string,
    fromVersionInclusive: StreamVersion | Position,
    count: number,
    direction = ReadDirection.Forward
  ): Promise<ReadStreamResult> {
    invariant.requiredString('streamId', streamId)
    invariant.required('afterVersion', fromVersionInclusive)
    invariant.required('count', count)
    InvalidParameterError.assert(count > 0, `count must be greater than zero`)
    fromVersionInclusive =
      fromVersionInclusive === Position.End
        ? Number.MAX_SAFE_INTEGER
        : fromVersionInclusive
    const forward = direction === ReadDirection.Forward
    const readStreamInfoQuery = scripts.readStreamInfo(streamId)

    const readStreamMessagesQuery = scripts.readStreamMessages(
      streamId,
      Math.max(0, fromVersionInclusive),
      count + 1,
      forward
    )

    const [messagesResult, infoResult] = (await pool.query(
      // Intentionally read the info last, because if messages are inserted
      // between the 2 queries (despite being sent in a single request), then
      // the stream info will have a higher version and position which means
      // we just keep reading.
      readStreamMessagesQuery + '; ' + readStreamInfoQuery
    )) as any

    const streamInfo = infoResult.rows[0] || null
    if (streamInfo === null) {
      return {
        nextVersion: 0,
        streamId: streamId,
        streamPosition: '0',
        streamVersion: 0,
        isEnd: true,
        messages: []
      }
    }

    const messages = [...messagesResult.rows]
    let isEnd = true
    if (messages.length === count + 1) {
      // Remove the extra end-check probe message
      messages.splice(messages.length - 1, 1)
      isEnd = false
    }

    return mapReadStreamResult(messages, streamInfo, isEnd, forward)
  }

  /**
   * Reads all messages from all streams in order.
   *
   * @param fromPositionInclusive
   * @param count
   */
  async function readAll(
    fromPositionInclusive: MessagePosition,
    count: number,
    direction = ReadDirection.Forward
  ): Promise<ReadAllResult> {
    invariant.required('fromPositionInclusive', fromPositionInclusive)
    invariant.required('count', count)
    InvalidParameterError.assert(count > 0, 'count should be greater than zero')
    return direction !== ReadDirection.Backward
      ? // This function reloads the page if gaps are detected.
        detectGapsAndReloadAll(
          logger,
          gapReloadDelay,
          gapReloadTimes,
          fromPositionInclusive,
          count,
          readAllInternal
        )
      : readAllInternal(fromPositionInclusive, count, ReadDirection.Backward)
  }

  /**
   * Internal readAll.
   * @param fromPositionInclusive
   * @param count
   */
  async function readAllInternal(
    fromPositionInclusive: MessagePosition | Position,
    count: number,
    direction = ReadDirection.Forward
  ): Promise<ReadAllResult> {
    fromPositionInclusive =
      fromPositionInclusive.toString() === Position.End.toString()
        ? MAX_BIG_VALUE
        : fromPositionInclusive
    const forward = direction === ReadDirection.Forward
    const messages = await pool
      .query(
        scripts.readAllMessages(
          count + 1,
          fromPositionInclusive as string,
          forward
        )
      )
      .then(r => [...r.rows].map((m: any) => mapMessageResult(m)))

    if (messages.length === 0) {
      return {
        isEnd: true,
        messages: [],
        nextPosition: forward
          ? fromPositionInclusive.toString()
          : /* istanbul ignore next */ '0'
      }
    }

    let isEnd = true
    if (messages.length === count + 1) {
      // We intentionally included another message to see if we are at the end.
      // We are not.
      isEnd = false
      messages.splice(messages.length - 1, 1)
    }

    const lastMessage = messages[messages.length - 1]
    const nextPosition = forward
      ? BigInteger(lastMessage.position)
          .plus(BigInteger.one)
          .toString()
      : // nextVersion will be 0 at the end, but that always includes the first message in
        // the stream. There's no way around this that does not skip the first message.
        BigInteger.max(
          BigInteger(lastMessage.position).minus(BigInteger.one),
          BigInteger.zero
        ).toString()

    return {
      isEnd,
      nextPosition,
      messages
    }
  }

  /**
   * Gets stream metadata.
   * @param streamId
   */
  async function getStreamMetadata(
    streamId: string
  ): Promise<StreamMetadataResult> {
    const result = await readStream(
      toMetadataStreamId(streamId),
      Position.End,
      1,
      ReadDirection.Backward
    )
    if (result.messages.length !== 1) {
      return {
        streamId,
        metadata: null,
        metadataStreamVersion: -1
      }
    }

    const message = result.messages[0]
    return {
      metadata: message.data.metadata,
      metadataStreamVersion: result.streamVersion,
      streamId: streamId
    }
  }

  /**
   * Sets stream metadata.
   */
  async function setStreamMetadata(
    streamId: string,
    expectedVersion: StreamVersion | ExpectedVersion,
    opts: SetStreamMetadataOptions
  ): Promise<SetStreamMetadataResult> {
    const metaStreamId = toMetadataStreamId(streamId)
    const result = await runInTransaction(pool, trx => {
      return trx
        .query(
          scripts.setStreamMetadata(streamId, metaStreamId, expectedVersion, {
            messageId: v4(),
            data: { metadata: opts.metadata },
            type: '$streamMetadata'
          })
        )
        .then(x => x.rows[0])
    })
    throwIfErrorCode(result.current_version)
    return { currentVersion: result.current_version }
  }

  /**
   * Subscribes to a stream.
   *
   * @param streamId
   * @param processMessage
   * @param subscriptionOptions
   */
  async function subscribeToStream(
    streamId: string,
    processMessage: MessageProcessor,
    subscriptionOptions?: StreamSubscriptionOptions
  ): Promise<StreamSubscription> {
    return new Promise<StreamSubscription>(resolve => {
      const subscription = createStreamSubscription(
        streamId,
        store,
        getNotifier(),
        logger,
        processMessage,
        {
          ...subscriptionOptions,
          onEstablished: () => {
            resolve(subscription)
          },
          dispose: async () => {
            _subscriptions.splice(_subscriptions.indexOf(subscription), 1)
            await callSubscriptionOptionsDisposer(subscriptionOptions)
            resolve(subscription)
          }
        }
      )
      _subscriptions.push(subscription)
    })
  }

  /**
   * Subscribes to the all-stream.
   *
   * @param processMessage
   * @param subscriptionOptions
   */
  async function subscribeToAll(
    processMessage: MessageProcessor,
    subscriptionOptions?: AllSubscriptionOptions
  ): Promise<AllSubscription> {
    return new Promise<AllSubscription>(resolve => {
      const subscription = createAllSubscription(
        store,
        getNotifier(),
        logger,
        processMessage,
        {
          ...subscriptionOptions,
          onEstablished: () => {
            resolve(subscription)
          },
          dispose: async () => {
            _subscriptions.splice(_subscriptions.indexOf(subscription), 1)
            await callSubscriptionOptionsDisposer(subscriptionOptions)
            resolve(subscription)
          }
        }
      )
      _subscriptions.push(subscription)
    })
  }

  /**
   * Disposes underlying resources (database connection, subscriptions, notifier).
   */
  async function dispose() {
    _disposing = true
    logger.trace(
      'pg-stream-store: dispose called, disposing all subscriptions..'
    )
    await Promise.all(_subscriptions.map(s => s.dispose()))
    if (_notifier) {
      await _notifier.dispose()
    }
    logger.trace(
      'pg-stream-store: all subscriptions disposed, waiting for all writes to finish..'
    )
    await _writeLatch.wait()
    logger.trace(
      'pg-stream-store: all writes finished, closing database connection..'
    )
    await pool.end()
    logger.trace(
      'pg-stream-store: database connection closed, stream store disposed.'
    )
  }

  /**
   * Creates a subscription disposer.
   *
   * @param opts
   * @param subscription
   */
  async function callSubscriptionOptionsDisposer(opts?: SubscriptionOptions) {
    return opts && opts.dispose && opts.dispose()
  }

  /**
   * Inserts a bunch of messages into a stream.
   * Creates the stream if it does not exist.
   *
   * @param streamId
   * @param streamType
   * @param expectedVersion
   * @param newMessages
   */
  async function insertMessages(
    streamId: string,
    expectedVersion: number,
    newMessages: NewStreamMessage[]
  ): Promise<InsertResult> {
    return runInTransaction(pool, trx => {
      return trx
        .query(scripts.append(streamId, expectedVersion, newMessages))
        .then(x => x.rows[0])
    })
  }

  /**
   * Gets or initializes a notifier.
   */
  function getNotifier() {
    if (_notifier) {
      return _notifier
    }
    _notifier =
      notifierConfig.type === 'pg-notify'
        ? createPostgresNotifier(pool, logger, notifierConfig.keepAliveInterval)
        : createPollingNotifier(
            notifierConfig.pollingInterval || 500,
            store.readHeadPosition,
            logger
          )
    logger.trace(`pg-stream-store: initialized ${notifierConfig.type} notifier`)
    return _notifier
  }
}

/**
 * Throws if the specified version is an error code.
 */
function throwIfErrorCode(version: number) {
  if (version === AppendResultCodes.ConcurrencyIssue) {
    throw new ConcurrencyError()
  }
}

/**
 * Maps the read stream DB result to the proper result.
 *
 * @param messages
 * @param streamInfo
 * @param forward
 */
function mapReadStreamResult(
  messages: any[],
  streamInfo: any,
  isEnd: boolean,
  forward: boolean
): ReadStreamResult {
  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null
  return {
    streamId: streamInfo.id,
    streamVersion: streamInfo.stream_version,
    streamPosition: streamInfo.position,
    streamType: streamInfo.stream_type,
    nextVersion: forward
      ? (lastMessage
          ? isEnd
            ? streamInfo.stream_version
            : lastMessage.stream_version
          : streamInfo.stream_version) + 1
      : Math.max(0, (isEnd ? 0 : lastMessage.stream_version) - 1),
    isEnd: isEnd,
    messages: messages.map(mapMessageResult)
  } as ReadStreamResult
}

/**
 * Maps a Message result.
 *
 * @param streamType
 * @param message
 */
function mapMessageResult(message: any): StreamMessage {
  return {
    streamId: message.stream_id,
    messageId: message.message_id,
    data: message.data,
    meta: message.meta,
    dateCreated: message.date_created,
    type: message.type,
    position: message.position,
    streamVersion: message.stream_version
  }
}

/**
 * Determines if the error is a unique constraint violation related to a concurrency issue.
 * @param err
 */
function isConcurrencyUniqueConstraintViolation(err: any) {
  return (
    err.message.endsWith('"stream_id_key"') ||
    err.message.endsWith('"message_stream_id_internal_stream_version_unique"')
  )
}

/**
 * Determines if the error is a unique constraint violation related to a concurrency issue.
 * @param err
 */
function isDuplicateMessageIdUniqueConstraintViolation(err: any) {
  return err.message.endsWith('"message_message_id_key"')
}

/**
 * Extracts the offending duplicate key from a UCV error.
 *
 * @param err
 */
function extractUuidKeyFromConstraintViolationError(err: any): string {
  const result = Array.from(
    /=\((.*?)\)/g.exec(err.detail) || /* istanbul ignore next */ []
  )
  return result.length > 1
    ? result[1]
    : /* istanbul ignore next */ '[unable to parse]'
}

/**
 * The result from the internal insert.
 */
interface InsertResult {
  current_version: number
  current_position: string
}

/**
 * Special `version` codes returned from the append sproc.
 */
enum AppendResultCodes {
  ConcurrencyIssue = -9
}

/**
 * Converts a stream ID to a metadata stream ID.
 * @param streamId
 */
function toMetadataStreamId(streamId: string) {
  return `$$ meta-${streamId} $$`
}
