import { MakeErrorClass } from 'fejl'

/**
 * Thrown when a concurrency error occurs in the event store.
 */
export class ConcurrencyError extends MakeErrorClass(
  'The expected version did not match that of the event store.'
) {}

/**
 * Thrown when a concurrency error occurs in the event store.
 */
export class DuplicateMessageError extends MakeErrorClass() {
  constructor(public id: string) {
    super(`Cannot insert message with duplicate ID "${id}"`)
  }
}

/**
 * Thrown when a concurrency error occurs in the event store.
 */
export class InconsistentStreamTypeError extends MakeErrorClass(
  'Attempted to write to a stream, but the stream type did not match.'
) {}

/**
 * Thrown when a resource is being/been disposed
 */
export class DisposedError extends MakeErrorClass(
  'The resource has been disposed.'
) {}

export class InvalidParameterError extends MakeErrorClass(
  'The parameter value is invalid.'
) {}
