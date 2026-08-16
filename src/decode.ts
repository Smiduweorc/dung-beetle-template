import { DecodeError } from "./errors.js";

/**
 * Reads a response body as JSON and asserts it is `T`.
 *
 * The assertion is unchecked: this layer describes what the API returns
 * without verifying it. Run a schema check in the layer that consumes the
 * wrapper if the API is not trusted.
 *
 * Use this inside a custom `decode` in place of `response.json()`: on
 * malformed JSON it raises a {@link DecodeError} carrying the raw body, which
 * is what tells you the API answered with an HTML error page.
 *
 * @throws {DecodeError} If the body is not valid JSON.
 */
export async function readJson<T>(response: Response): Promise<T> {
	const body = await response.text();

	try {
		return JSON.parse(body) as T;
	} catch (cause) {
		throw new DecodeError({
			url: response.url,
			status: response.status,
			body,
			cause,
		});
	}
}
