import type { Transport } from "./client.js";
import { readJson } from "./decode.js";
import { ApiError, DecodeError, HttpError, TransportError } from "./errors.js";
import type { RequestHeaders } from "./operation.js";

// JSON-RPC 2.0 over HTTP POST, which is what an OpenRPC document describes.
// Batches and notifications are left out: a batch is several calls whose
// failures the caller has to sort out one by one, and a notification is a call
// whose failure nobody hears about.

/**
 * A description of one JSON-RPC call: the method name and its params, already
 * in the structure the document declared. A plain value, like `Operation`, so
 * building one performs no I/O.
 *
 * `TResult` is what `request()` resolves to. Nothing checks the result against
 * it at runtime.
 */
export interface RpcCall<TResult> {
	/** Method name as the API spells it on the wire, such as `eth_getBalance`. */
	readonly method: string;

	/** Positional params as an array, named params as an object. */
	readonly params?: readonly unknown[] | Readonly<Record<string, unknown>>;

	/**
	 * Only here to carry `TResult`; never set. Without a member that mentions
	 * it, every `RpcCall` would be assignable to every other.
	 */
	readonly _result?: TResult;
}

/** Configuration for an {@link RpcClient}. */
export interface RpcClientOptions {
	/**
	 * URL every call is posted to. Throws `TypeError` if it is not a valid
	 * absolute URL.
	 */
	readonly url: string | URL;

	/**
	 * How requests are sent. Defaults to the global `fetch`, looked up at call
	 * time rather than at import time. The same {@link Transport} the
	 * `ApiClient` takes, so one decorator serves both.
	 */
	readonly transport?: Transport;

	/** Headers sent with every call, such as an API key. A call's headers override these key by key. */
	readonly headers?: RequestHeaders;
}

/** Per-call options for {@link RpcClient.request}. */
export interface RpcRequestOptions {
	/** Cancels the call. Aborting surfaces as a {@link TransportError}. */
	readonly signal?: AbortSignal;

	/** Headers for this call only, overriding the client's. */
	readonly headers?: RequestHeaders;
}

/**
 * The server answered with a JSON-RPC error object. HTTP itself succeeded, so
 * this is the API refusing the call, not the network failing it.
 */
export class RpcError extends ApiError {
	override readonly name = "RpcError";

	/** Method that was called. */
	readonly method: string;

	/** URL the call was posted to. */
	readonly url: string;

	/** `error.code`. -32768 to -32000 are reserved by JSON-RPC itself; the rest are the API's. */
	readonly code: number;

	/** `error.data`, the API's own detail, when it sent any. */
	readonly data: unknown;

	constructor(init: { method: string; url: string; code: number; message: string; data?: unknown }) {
		super(`${init.method} at ${init.url} failed with JSON-RPC error ${init.code}: ${init.message}`);
		this.method = init.method;
		this.url = init.url;
		this.code = init.code;
		this.data = init.data;
	}
}

/**
 * Posts an {@link RpcCall} as a JSON-RPC 2.0 request, sends it through the
 * transport, and unwraps the response.
 *
 * Constructing a client opens no connection, reads no environment and
 * schedules no work. Request ids count up from 1 per client; they only have to
 * match the response, since every call is its own HTTP request.
 */
export class RpcClient {
	readonly #url: URL;
	readonly #transport: Transport;
	readonly #headers: Headers;
	#nextId = 1;

	constructor(options: RpcClientOptions) {
		this.#url = new URL(options.url.toString());
		this.#transport =
			options.transport ?? ((request): Promise<Response> => fetch(request));
		this.#headers = new Headers(options.headers);
	}

	/**
	 * Performs `call` once and resolves with its `result`.
	 *
	 * @throws {TransportError} If the transport rejected, including on abort.
	 * @throws {HttpError} If the server answered with a non-2xx status.
	 * @throws {RpcError} If the response carried a JSON-RPC error object.
	 * @throws {DecodeError} If the body was not a JSON-RPC response to this call.
	 */
	async request<TResult>(call: RpcCall<TResult>, options: RpcRequestOptions = {}): Promise<TResult> {
		const url = this.#url.toString();
		const id = this.#nextId++;
		const headers = new Headers(this.#headers);

		for (const [key, value] of new Headers(options.headers)) {
			headers.set(key, value);
		}
		headers.set("content-type", "application/json");

		const request = new Request(url, {
			method: "POST",
			headers,
			body: JSON.stringify({ jsonrpc: "2.0", id, method: call.method, params: call.params }),
			signal: options.signal,
		});

		let response: Response;
		try {
			response = await this.#transport(request);
		} catch (cause) {
			throw new TransportError({ method: "POST", url, cause });
		}

		if (!response.ok) {
			let body: string | undefined;
			try {
				body = await response.text();
			} catch {
				body = undefined;
			}
			throw new HttpError({
				method: "POST",
				url,
				status: response.status,
				statusText: response.statusText,
				headers: response.headers,
				body,
			});
		}

		const envelope = await readJson<unknown>(response);
		const refuse = (reason: string): DecodeError =>
			new DecodeError({
				url: response.url,
				status: response.status,
				body: JSON.stringify(envelope),
				cause: new TypeError(reason),
			});

		if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
			throw refuse("the body is not a JSON-RPC response object");
		}

		const answer = envelope as Record<string, unknown>;
		if (answer["jsonrpc"] !== "2.0") {
			throw refuse("the body does not say `\"jsonrpc\": \"2.0\"`");
		}
		if (answer["id"] !== id) {
			throw refuse(`the response id ${JSON.stringify(answer["id"])} does not match the request id ${id}`);
		}

		if ("error" in answer) {
			const error = answer["error"];
			if (
				typeof error !== "object" ||
				error === null ||
				typeof (error as Record<string, unknown>)["code"] !== "number" ||
				typeof (error as Record<string, unknown>)["message"] !== "string"
			) {
				throw refuse("`error` is not an object with a numeric `code` and a string `message`");
			}
			const { code, message, data } = error as { code: number; message: string; data?: unknown };
			throw new RpcError({ method: call.method, url, code, message, data });
		}
		if (!("result" in answer)) {
			throw refuse("the body has neither `result` nor `error`");
		}

		return answer["result"] as TResult;
	}
}

/**
 * Positional params with trailing omitted ones dropped, so a call leaving out
 * optional params sends the shorter array the server expects. An omitted param
 * followed by a given one has no position to leave empty, so it is sent as
 * `null`, which is what JSON-RPC servers read as absent.
 */
export function positional(values: readonly unknown[]): readonly unknown[] {
	let end = values.length;
	while (end > 0 && values[end - 1] === undefined) {
		end--;
	}

	return values.slice(0, end).map((value) => (value === undefined ? null : value));
}
