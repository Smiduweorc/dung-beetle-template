// Kept byte-identical with the copy in the other template (Aphid-template and
// dung-beetle-template ship the same runtime). Change one, change both.
import type { Transport } from "../client.js";

/**
 * Produces the current token.
 *
 * Called once per request, so caching and expiry belong here: the decorator
 * deduplicates concurrent calls but remembers nothing between them. A function
 * that already holds a valid token should return it without doing any work.
 */
export type TokenSource = () => string | Promise<string>;

/**
 * Sends `authorization: Bearer <token>` on every request, asking `getToken`
 * for the value.
 *
 * A static token needs none of this: put it in the client's `headers` and it
 * is sent with every request. This exists for a credential that expires, where
 * the header has to be built per attempt rather than once at construction.
 *
 * Concurrent requests share one call to `getToken`. Ten requests arriving on an
 * expired token ask for one token rather than ten, which is the part that is
 * easy to get wrong and expensive to get wrong against a rate-limited token
 * endpoint. The shared promise is dropped as soon as it settles, so the next
 * request asks again and nothing here decides when a token has expired.
 *
 * `getToken` returns the token itself, not the header value: the `Bearer`
 * prefix is added here. A rejection propagates to the caller as a
 * `TransportError`, and leaves nothing cached, so the next request retries.
 *
 * The header is set on the request rather than on a copy of it, so the body is
 * never read and a retrying decorator wrapped around this one can still clone.
 * Any `authorization` header already on the request is replaced.
 *
 * ```ts
 * const api = new ApiClient({
 * 	baseUrl: "https://api.example.com/v1",
 * 	transport: withBearerToken(fetch, () => tokens.current()),
 * });
 * ```
 */
export function withBearerToken(inner: Transport, getToken: TokenSource): Transport {
	let pending: Promise<string> | undefined;

	const token = async (): Promise<string> => {
		pending ??= Promise.resolve(getToken()).finally(() => {
			pending = undefined;
		});

		return pending;
	};

	return async (request) => {
		const authorized = request.clone();
		authorized.headers.set("authorization", `Bearer ${await token()}`);

		return inner(authorized);
	};
}
