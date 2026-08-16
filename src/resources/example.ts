import { readJson } from "../decode.js";
import type { Operation } from "../operation.js";

/**
 * One worked resource, kept as the pattern to copy. Delete this file, its test
 * and its exports in `index.ts` once your own resources exist.
 *
 * The pattern to copy: response types named after what the API returns, and
 * one exported function per endpoint that returns an `Operation` without
 * performing I/O. Nothing in a resource module runs until a client is handed
 * the operation.
 *
 * Request fields are named for TypeScript and mapped to the API's wire names
 * (`perPage` becomes `per_page`), which is what makes the parameters
 * discoverable from the type. Response fields keep the API's own names, so a
 * field in the API's documentation has the same name in the type. Renaming
 * them is a per-resource decision that belongs in `decode`, and costs you a
 * mapping function to maintain.
 */

/** An example record as the API returns it. */
export interface Example {
	readonly id: string;
	readonly name: string;
	readonly tags: readonly string[];
	readonly created_at: string;
}

/** Envelope the list endpoint wraps its page in. */
export interface ExampleListResponse {
	readonly data: readonly Example[];
	readonly meta: {
		readonly page: number;
		readonly per_page: number;
		readonly total: number;
	};
}

/** Filters accepted by {@link listExamples}. */
export interface ListExamplesQuery {
	readonly page?: number;
	readonly perPage?: number;
	readonly tags?: readonly string[];
}

/** Fields accepted by {@link createExample}. */
export interface NewExample {
	readonly name: string;
	readonly tags?: readonly string[];
}

/**
 * `GET /examples`. One page of examples, with the API's pagination envelope
 * left intact because the caller needs `meta` to ask for the next page.
 */
export function listExamples(
	query: ListExamplesQuery = {}
): Operation<ExampleListResponse> {
	return {
		method: "GET",
		path: "/examples",
		query: {
			page: query.page,
			per_page: query.perPage,
			tag: query.tags,
		},
	};
}

/**
 * `GET /examples/{id}`. A single example, unwrapped from its `data` envelope
 * because there is nothing else in it.
 */
export function getExample(id: string): Operation<Example> {
	return {
		method: "GET",
		path: `/examples/${encodeURIComponent(id)}`,
		decode: async (response) => {
			const { data } = await readJson<{ data: Example }>(response);
			return data;
		},
	};
}

/**
 * `POST /examples`. Creates one. A JSON body needs its `content-type` set
 * explicitly; a `URLSearchParams` or `FormData` body would set its own.
 */
export function createExample(input: NewExample): Operation<Example> {
	return {
		method: "POST",
		path: "/examples",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input),
		decode: async (response) => {
			const { data } = await readJson<{ data: Example }>(response);
			return data;
		},
	};
}
