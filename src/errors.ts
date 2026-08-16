import type { HttpMethod } from "./operation.js";

/**
 * Base class for every error this package throws.
 *
 * Catch `ApiError` to catch all of them; catch a subclass to react to one
 * failure mode. The three subclasses split the failure into "the request never
 * produced a response" ({@link TransportError}), "the API answered with a
 * non-2xx status" ({@link HttpError}) and "the response arrived but could not
 * be read as the declared type" ({@link DecodeError}).
 */
export abstract class ApiError extends Error {
	protected constructor(message: string, options?: ErrorOptions) {
		super(message, options);
	}
}

/**
 * The transport rejected, so no response was ever received: a DNS failure, a
 * refused or reset connection, a TLS error, or an aborted request.
 *
 * The original rejection is on `cause`. An abort surfaces here with an
 * `AbortError` `DOMException` as its cause.
 */
export class TransportError extends ApiError {
	override readonly name = "TransportError";

	/** Method of the request that failed. */
	readonly method: HttpMethod;

	/** Absolute URL the request was sent to. */
	readonly url: string;

	constructor(init: { method: HttpMethod; url: string; cause?: unknown }) {
		super(`${init.method} ${init.url} failed before a response was received`, {
			cause: init.cause,
		});
		this.method = init.method;
		this.url = init.url;
	}
}

/**
 * The API answered with a non-2xx status.
 *
 * The response body is read as text and kept on `body` so the caller can parse
 * the API's own error shape. `body` is `undefined` only when reading it failed.
 */
export class HttpError extends ApiError {
	override readonly name = "HttpError";

	/** Method of the request that failed. */
	readonly method: HttpMethod;

	/** Absolute URL the request was sent to. */
	readonly url: string;

	/** HTTP status code. */
	readonly status: number;

	/** HTTP status text, which many APIs leave empty. */
	readonly statusText: string;

	/** Response headers, including anything the API uses to explain the failure. */
	readonly headers: Headers;

	/** Raw response body, or `undefined` if the body could not be read. */
	readonly body: string | undefined;

	constructor(init: {
		method: HttpMethod;
		url: string;
		status: number;
		statusText: string;
		headers: Headers;
		body: string | undefined;
	}) {
		const status = init.statusText
			? `HTTP ${init.status} ${init.statusText}`
			: `HTTP ${init.status}`;
		super(`${init.method} ${init.url} failed with ${status}`);
		this.method = init.method;
		this.url = init.url;
		this.status = init.status;
		this.statusText = init.statusText;
		this.headers = init.headers;
		this.body = init.body;
	}
}

/**
 * A 2xx response arrived but could not be turned into the operation's result
 * type: malformed JSON, an empty body where one was expected, or a rejection
 * thrown by a custom `decode`.
 *
 * `body` holds the raw text when the failure came from {@link readJson}; a
 * custom `decode` that consumes the body itself leaves it `undefined`.
 */
export class DecodeError extends ApiError {
	override readonly name = "DecodeError";

	/** URL the response came from, after redirects. Empty for a synthesised `Response`. */
	readonly url: string;

	/** Status of the response that could not be decoded. */
	readonly status: number;

	/** Raw response body, when it was still available. */
	readonly body: string | undefined;

	constructor(init: {
		url: string;
		status: number;
		body?: string;
		cause?: unknown;
	}) {
		const where = init.url ? ` from ${init.url}` : "";
		super(`Could not decode the HTTP ${init.status} response body${where}`, {
			cause: init.cause,
		});
		this.url = init.url;
		this.status = init.status;
		this.body = init.body;
	}
}
