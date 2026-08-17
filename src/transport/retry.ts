// Kept byte-identical with the copy in the other template (Aphid-template and
// dung-beetle-template ship the same runtime). Change one, change both.
import type { Transport } from "../client.js";

/**
 * Methods retried by default: the ones where sending the same request twice
 * means the same thing as sending it once.
 *
 * `POST` is missing on purpose. A `POST` that was received and answered with a
 * dropped connection has already happened, and repeating it charges the card
 * again. Widen this only for an API that takes an idempotency key.
 */
const IDEMPOTENT = ["GET", "HEAD", "OPTIONS", "PUT", "DELETE"];

/** Statuses retried by default: the ones that usually mean "not now". */
const TRANSIENT = [408, 425, 429, 500, 502, 503, 504];

export interface RetryOptions {
	/** Total sends, first attempt included. Defaults to 3, so two retries. */
	readonly attempts?: number;

	/** First backoff window in milliseconds, doubling each attempt. Defaults to 200. */
	readonly baseDelay?: number;

	/**
	 * Longest wait between attempts, in milliseconds. Defaults to 5000. A
	 * `Retry-After` asking for longer than this ends the retrying instead of
	 * being shortened, because arriving early is what the server asked you not
	 * to do.
	 */
	readonly maxDelay?: number;

	/** Statuses worth another attempt. Defaults to 408, 425, 429, 500, 502, 503 and 504. */
	readonly retryOn?: readonly number[];

	/** Methods worth another attempt. Defaults to every method except `POST` and `PATCH`. */
	readonly methods?: readonly string[];
}

/**
 * Sends a request again when it fails in a way that might not fail twice.
 *
 * What it retries: a transport that rejected, and a response whose status is
 * in `retryOn`, for a request whose method is in `methods`. What it leaves
 * alone: anything the caller aborted, since that failure is the caller's own
 * doing, and a method that is not safe to repeat.
 *
 * Waits grow (`baseDelay`, then double, capped at `maxDelay`) and are jittered
 * across the whole window, so a fleet that failed together does not return
 * together. A `Retry-After` header is honoured over the computed wait.
 *
 * Every attempt sends its own clone, because a `Request` body reads once and
 * the second attempt would otherwise send an empty one.
 *
 * ```ts
 * const api = new ApiClient({
 * 	baseUrl: "https://api.example.com/v1",
 * 	transport: withRetry(withBearerToken(fetch, () => tokens.current())),
 * });
 * ```
 *
 * Wrapping this around `withBearerToken`, as above, asks for the token per
 * attempt, so a retry after a 401 carries a fresh one. The other order works
 * and reuses the first token for every attempt.
 */
export function withRetry(inner: Transport, options: RetryOptions = {}): Transport {
	const attempts = options.attempts ?? 3;
	const baseDelay = options.baseDelay ?? 200;
	const maxDelay = options.maxDelay ?? 5_000;
	const statuses = new Set(options.retryOn ?? TRANSIENT);
	const methods = new Set((options.methods ?? IDEMPOTENT).map((method) => method.toUpperCase()));

	return async (request) => {
		if (attempts <= 1 || !methods.has(request.method.toUpperCase())) {
			return inner(request);
		}

		for (let attempt = 1; ; attempt += 1) {
			const last = attempt >= attempts;
			let response: Response;

			try {
				response = await inner(request.clone());
			} catch (cause) {
				// An abort is the caller changing their mind, not a failure to
				// work around.
				if (last || request.signal.aborted) {
					throw cause;
				}
				await sleep(backoff(attempt, baseDelay, maxDelay), request.signal);
				continue;
			}

			if (last || !statuses.has(response.status)) {
				return response;
			}

			const asked = retryAfter(response);
			if (asked !== undefined && asked > maxDelay) {
				return response;
			}

			await sleep(asked ?? backoff(attempt, baseDelay, maxDelay), request.signal);
		}
	};
}

/** Somewhere in the window, rather than at the end of it. */
function backoff(attempt: number, baseDelay: number, maxDelay: number): number {
	return Math.random() * Math.min(maxDelay, baseDelay * 2 ** (attempt - 1));
}

/** `Retry-After` in milliseconds, as either a count of seconds or a date. */
function retryAfter(response: Response): number | undefined {
	const header = response.headers.get("retry-after")?.trim();

	if (!header) {
		return undefined;
	}

	const seconds = Number(header);
	if (Number.isFinite(seconds)) {
		return Math.max(0, seconds * 1_000);
	}

	const when = Date.parse(header);
	return Number.isNaN(when) ? undefined : Math.max(0, when - Date.now());
}

/**
 * Waits, unless the caller gives up first. `node:timers/promises` has this
 * with a signal, and is not there in a browser.
 */
async function sleep(ms: number, signal: AbortSignal): Promise<void> {
	if (ms <= 0) {
		return;
	}
	if (signal.aborted) {
		throw signal.reason;
	}

	await new Promise<void>((resolve, reject) => {
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);

		signal.addEventListener("abort", onAbort, { once: true });
	});
}
