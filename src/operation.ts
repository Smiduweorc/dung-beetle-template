/**
 * Headers accepted by the runtime's `Request`, derived from it rather than
 * redeclared so this compiles the same under Node types and DOM types.
 */
export type RequestHeaders = NonNullable<
	NonNullable<ConstructorParameters<typeof Request>[1]>["headers"]
>;

/** Request body accepted by the runtime's `Request`. */
export type RequestBody = NonNullable<
	NonNullable<ConstructorParameters<typeof Request>[1]>["body"]
>;

/** HTTP methods an {@link Operation} can use. */
export type HttpMethod =
	| "GET"
	| "POST"
	| "PUT"
	| "PATCH"
	| "DELETE"
	| "HEAD"
	| "OPTIONS";

/**
 * A single query-string value. `null` and `undefined` are dropped, an array
 * becomes one repeated key per item, and every other value goes through
 * `String()`.
 */
export type QueryValue =
	| string
	| number
	| boolean
	| readonly (string | number | boolean)[]
	| null
	| undefined;

/** Query string of an {@link Operation}, keyed by the wire name the API expects. */
export type QueryParams = Readonly<Record<string, QueryValue>>;

/**
 * A description of one endpoint call.
 *
 * An operation is a plain value: building one performs no I/O, which keeps
 * this layer testable without a network. Write one function per endpoint that
 * returns an `Operation`, then hand it to {@link ApiClient.request}.
 *
 * `TResult` is what `request()` resolves to. Nothing checks the response
 * against it at runtime; see `decode`.
 */
export interface Operation<TResult> {
	/** HTTP method for this endpoint. */
	readonly method: HttpMethod;

	/**
	 * Path relative to the client's `baseUrl`, with path parameters already
	 * interpolated and escaped with `encodeURIComponent`. A leading slash is
	 * optional and never replaces the base path. Query strings do not belong
	 * here; use `query`.
	 */
	readonly path: string;

	/** Query parameters, keyed by the name the API expects on the wire. */
	readonly query?: QueryParams;

	/** Headers for this endpoint, overriding the client's defaults key by key. */
	readonly headers?: RequestHeaders;

	/**
	 * Request body. Passed to `Request` untouched, so a `URLSearchParams` or a
	 * `FormData` sets its own content type while a JSON string needs an
	 * explicit `content-type` header. Streams are out of scope.
	 */
	readonly body?: RequestBody;

	/**
	 * Turns the response into `TResult`. Defaults to `readJson`, which parses
	 * the body as JSON and asserts it matches `TResult` without checking.
	 *
	 * Override it to unwrap an envelope, to read text instead of JSON, or to
	 * resolve `undefined` for an endpoint that answers 204. Anything thrown
	 * here that is not already an `ApiError` is wrapped in a `DecodeError`.
	 */
	readonly decode?: (response: Response) => Promise<TResult>;
}
