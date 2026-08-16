import { readJson } from "./decode.js";
import { ApiError, DecodeError, HttpError, TransportError } from "./errors.js";
import type { Operation, RequestHeaders } from "./operation.js";
import { buildUrl } from "./url.js";

/**
 * Sends one `Request` and resolves with the response.
 *
 * `fetch` satisfies this directly. It is also the one place to add the
 * behaviour this package leaves out (retries, caching, rate limiting, a
 * circuit breaker, request logging, token refresh), by wrapping a transport in
 * another transport. The client calls it exactly once per `request()`, so a
 * decorator sees every attempt and owns every retry.
 */
export type Transport = (request: Request) => Promise<Response>;

/** Configuration for an {@link ApiClient}. */
export interface ApiClientOptions {
	/**
	 * Root URL every operation path is joined onto, including any version
	 * prefix. Throws `TypeError` if it is not a valid absolute URL.
	 */
	readonly baseUrl: string | URL;

	/**
	 * How requests are sent. Defaults to the global `fetch`, looked up at call
	 * time rather than at import time.
	 */
	readonly transport?: Transport;

	/**
	 * Headers sent with every request, such as an API key, an `accept` or a
	 * user agent. An operation's headers and a call's headers override these key
	 * by key.
	 */
	readonly headers?: RequestHeaders;
}

/** Per-call options for {@link ApiClient.request}. */
export interface RequestOptions {
	/** Cancels the request. Aborting surfaces as a {@link TransportError}. */
	readonly signal?: AbortSignal;

	/** Headers for this call only, overriding both the client's and the operation's. */
	readonly headers?: RequestHeaders;
}

/**
 * Turns an {@link Operation} into a request, sends it through the transport,
 * and decodes the response.
 *
 * Constructing a client opens no connection, reads no environment and
 * schedules no work.
 */
export class ApiClient {
	readonly #baseUrl: URL;
	readonly #transport: Transport;
	readonly #headers: Headers;

	constructor(options: ApiClientOptions) {
		this.#baseUrl = new URL(options.baseUrl.toString());
		this.#transport =
			options.transport ?? ((request): Promise<Response> => fetch(request));
		this.#headers = new Headers(options.headers);
	}

	/**
	 * Performs `operation` once and resolves with its result.
	 *
	 * One operation is one call to the transport. A failure is reported to the
	 * caller, which is where the decision to retry, wait or give up belongs.
	 *
	 * @throws {TransportError} If the transport rejected, including on abort.
	 * @throws {HttpError} If the API answered with a non-2xx status.
	 * @throws {DecodeError} If the response body could not be read as `TResult`.
	 */
	async request<TResult>(
		operation: Operation<TResult>,
		options: RequestOptions = {}
	): Promise<TResult> {
		const url = buildUrl(this.#baseUrl, operation.path, operation.query);
		const headers = new Headers(this.#headers);

		for (const [key, value] of new Headers(operation.headers)) {
			headers.set(key, value);
		}
		for (const [key, value] of new Headers(options.headers)) {
			headers.set(key, value);
		}

		const request = new Request(url, {
			method: operation.method,
			headers,
			body: operation.body,
			signal: options.signal,
		});

		let response: Response;
		try {
			response = await this.#transport(request);
		} catch (cause) {
			throw new TransportError({
				method: operation.method,
				url: url.toString(),
				cause,
			});
		}

		if (!response.ok) {
			throw new HttpError({
				method: operation.method,
				url: url.toString(),
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
				body: await readBodyForError(response),
			});
		}

		const decode = operation.decode ?? readJson<TResult>;

		try {
			return await decode(response);
		} catch (cause) {
			if (cause instanceof ApiError) {
				throw cause;
			}
			throw new DecodeError({
				url: url.toString(),
				status: response.status,
				cause,
			});
		}
	}
}

/**
 * Reads an error response body. A body that cannot be read is reported as
 * `undefined`, so the {@link HttpError} describing the status still reaches
 * the caller.
 */
async function readBodyForError(response: Response): Promise<string | undefined> {
	try {
		return await response.text();
	} catch {
		return undefined;
	}
}
