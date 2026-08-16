import type { QueryParams } from "./operation.js";

/**
 * Query serialisations `buildUrl` cannot produce on its own.
 *
 * `buildUrl` sends one repeated key per array item, which is what OpenAPI's
 * default (`style: form`, `explode: true`) means. A document that asks for
 * anything else describes a different set of keys, and building those is this
 * layer's job: the endpoint that reads them is the one the wrapper describes.
 *
 * Both functions take `unknown`, because the value comes from whatever shape
 * the document declared and no narrower type would accept every one of them.
 */

/**
 * A `deepObject` parameter, spread into the bracketed keys it names:
 * `{ gte: 1 }` under `created` becomes `created[gte]=1`.
 *
 * Nested objects keep nesting (`created[range][gte]`), and arrays are indexed
 * (`expand[0]`), which is the one form that also carries objects inside them.
 * A plain value passes through under its own name, since documents that accept
 * an object here usually accept a scalar too. `null` and `undefined` send
 * nothing.
 */
export function deepObject(name: string, value: unknown): QueryParams {
	if (value === undefined || value === null) {
		return {};
	}

	if (Array.isArray(value)) {
		return Object.assign(
			{},
			...value.map((item, index) => deepObject(`${name}[${index}]`, item))
		) as QueryParams;
	}

	if (typeof value === "object") {
		return Object.assign(
			{},
			...Object.entries(value).map(([key, nested]) => deepObject(`${name}[${key}]`, nested))
		) as QueryParams;
	}

	return { [name]: String(value) };
}

/**
 * A parameter the document does not explode, joined into one value: a comma
 * for `style: form`, a space for `spaceDelimited`, a bar for `pipeDelimited`.
 *
 * An empty array sends nothing, the same as `buildUrl` does with one, so an
 * empty filter does not arrive as `?tag=`.
 */
export function joined(value: unknown, separator: string): string | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}

	if (Array.isArray(value)) {
		return value.length > 0 ? value.map(String).join(separator) : undefined;
	}

	return String(value);
}
