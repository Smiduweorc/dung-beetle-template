import pluralize from "pluralize";

import type { HttpMethod } from "../../src/operation.js";
import type { SpecOperation } from "./model.js";

// Turns a method and a path into the names a reader sees. This is the wrapping
// style, so it is the one part of the generator that is ours rather than
// bought. `operationId` is never used: real documents emit
// `read_user_users__user_id__get`, and GitHub emits `agents/get-repo-public-key`.

/** A path segment that only says which version of the API this is. */
const VERSION_SEGMENT = /^v\d+$/iu;

const PARAMETER_SEGMENT = /^\{.+\}$/u;

/**
 * The words an identifier is built from: runs of letters and digits, split
 * again where one word runs into the next in camel case. `listUsers` has to
 * come apart into `list` and `users`, or `typeName` would return `Listusers`.
 */
const WORDS = /[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z0-9]+/gu;

/** What the rest of the document says about one path, which the path alone cannot. */
export interface NameContext {
	/** The document also describes items under this path, so it is a collection. */
	readonly hasItems?: boolean;

	/**
	 * The path ends with a parameter qualifying an item the document already
	 * addresses, as `/gists/{gist_id}/{sha}` qualifies `/gists/{gist_id}`. The
	 * qualifier joins the name, since without it both endpoints read the same.
	 */
	readonly qualifier?: string;
}

interface PathShape {
	/** Literal segments, with version prefixes dropped. */
	readonly nouns: readonly string[];

	/** The path ends with a parameter, so the operation acts on one item. */
	readonly item: boolean;

	/** The path ends with a literal that follows a parameter. */
	readonly nested: boolean;
}

function shapeOf(path: string): PathShape {
	const segments = path
		.split("/")
		.filter((segment) => segment.length > 0 && !VERSION_SEGMENT.test(segment));
	const last = segments.at(-1);

	return {
		nouns: segments.filter((segment) => !PARAMETER_SEGMENT.test(segment)),
		item: last !== undefined && PARAMETER_SEGMENT.test(last),
		nested: segments.length > 1 && PARAMETER_SEGMENT.test(segments.at(-2) ?? ""),
	};
}

/**
 * The verb a method reads as, and whether it names one thing or many.
 *
 * `POST` on a single item is `update`, because an API that uses `POST` to
 * modify means exactly that (Stripe's whole write surface does). A document
 * with both `POST /x/{id}` and `PATCH /x/{id}` produces the same name twice
 * and is reported as a collision for the `names` map to settle.
 */
function verbOf(method: HttpMethod, one: boolean): { verb: string; one: boolean } {
	switch (method) {
	case "GET":
		return one ? { verb: "get", one } : { verb: "list", one };
	case "POST":
		return one ? { verb: "update", one } : { verb: "create", one: true };
	case "PUT":
		return { verb: "replace", one };
	case "PATCH":
		return { verb: "update", one };
	case "DELETE":
		return { verb: "delete", one };
	case "HEAD":
		return { verb: "head", one };
	case "OPTIONS":
		return { verb: "options", one };
	}
}

/**
 * The exported function name for one endpoint.
 *
 * `GET /users` is `listUsers` and `GET /users/{id}` is `getUser`, split by
 * what the path points at rather than by the method alone. A nested collection
 * folds its parent in, so `GET /users/{id}/sessions` is `listUserSessions`.
 *
 * A singular segment posted to after a parameter reads as the API's own verb,
 * so `POST /users/{id}/activate` is `activateUser`. Other methods read that
 * same shape as a sub-resource, so `PUT /users/{id}/profile` is
 * `replaceUserProfile`. A singular segment that is posted to and is a
 * sub-resource rather than a verb (`POST /users/{id}/profile`) comes out as
 * `profileUser`, which is what the `names` map in the config is for.
 */
export function functionName(operation: SpecOperation, context: NameContext = {}): string {
	const { nouns, item, nested } = shapeOf(operation.path);
	const target = nouns.at(-1);

	if (target === undefined) {
		return camelCase([operation.method.toLowerCase(), "root"]);
	}

	const parents = nouns.slice(0, -1).map((noun) => pluralize.singular(noun));
	// A path the document also has items under is a collection whatever its
	// noun looks like. Without this, `/codes_of_conduct` and
	// `/codes_of_conduct/{key}` both read as one thing and take the same name.
	const singleton = !item && !pluralize.isPlural(target) && context.hasItems !== true;

	// A verb the API named itself, which keeps its own word. Only `POST`,
	// because `PUT /users/{id}/profile` is a singleton sub-resource being
	// written rather than a verb called `profile`.
	if (singleton && nested && operation.method === "POST") {
		return camelCase([target, ...parents]);
	}

	const { verb, one } = verbOf(operation.method, item || singleton);
	// A collection keeps the word the API chose. Pluralising it invents
	// `listCodesOfConducts` and `listBalanceHistories` out of paths that read
	// perfectly well as they are.
	const subject = one ? pluralize.singular(target) : target;
	const qualifier = context.qualifier === undefined ? [] : ["by", trim(context.qualifier, target)];

	return camelCase([verb, ...parents, subject, ...qualifier]);
}

/** Drops the noun a qualifier repeats, so `{app_slug}` under `/apps` reads as `bySlug`. */
function trim(qualifier: string, target: string): string {
	const singular = pluralize.singular(target).toLowerCase();
	const remaining = words(qualifier).filter((word) => word.toLowerCase() !== singular);

	return remaining.length > 0 ? remaining.join(" ") : "id";
}

/**
 * The module an endpoint is written to, without an extension: the first
 * segment of its path that names something. Grouping by path rather than by
 * `tags` keeps a module's contents predictable from its endpoints, and real
 * documents tag by product area rather than by resource.
 */
export function moduleName(operation: SpecOperation): string {
	const { nouns } = shapeOf(operation.path);
	const first = nouns[0];

	return first === undefined ? "root" : kebabCase(first);
}

/** A type name for something the document named, such as a component schema. */
export function typeName(name: string): string {
	return pascalCase(words(name));
}

/** A parameter's name in TypeScript. The wire name it maps to stays in the operation. */
export function parameterName(name: string): string {
	return camelCase(words(name));
}

function words(value: string): readonly string[] {
	return value.match(WORDS) ?? [];
}

function camelCase(parts: readonly string[]): string {
	const [first, ...rest] = parts
		.flatMap((part) => words(part))
		.map((word) => word.toLowerCase());
	const name = `${first ?? ""}${rest.map(capitalize).join("")}`;

	// An identifier cannot open with a digit, which a path segment can.
	return /^\d/u.test(name) ? `_${name}` : name;
}

function pascalCase(parts: readonly string[]): string {
	return capitalize(camelCase(parts));
}

function kebabCase(value: string): string {
	return words(value)
		.map((word) => word.toLowerCase())
		.join("-");
}

function capitalize(value: string): string {
	return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
