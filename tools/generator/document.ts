// Reads OpenAPI documents. The rest of the generator depends on
// `NormalizedDocument` instead of on this file, so parsing, `$ref` resolution
// and version handling stay in one place.
//
// Parsing comes from `@redocly/openapi-core`, pinned to the major that
// `openapi-typescript` resolves through (it depends on `^1.34.6` as of 7.13.0).
// One resolver behind both means the emitted types and this model cannot
// disagree about what a `$ref` points at.

import {
	BaseResolver,
	bundle,
	createConfig,
	detectSpec,
	isRef,
	lint,
	SpecVersion,
	unescapePointer,
} from "@redocly/openapi-core";
import type {
	NormalizedProblem,
	Oas3Definition,
	Oas3PathItem,
	OasRef,
	Referenced,
} from "@redocly/openapi-core";

import type { HttpMethod } from "../../src/operation.js";
import { byKey } from "./order.js";
import type {
	NormalizedDocument,
	ParameterStyle,
	SpecOAuth2Scheme,
	SpecOperation,
	SpecParameter,
	SpecRequestBody,
	SpecResponse,
	SpecSecurityScheme,
	SpecServer,
} from "./model.js";

/** One thing wrong with a document, as `@redocly/openapi-core` reported it. */
export interface SpecProblem {
	readonly message: string;

	/** Rule that reported it, `struct` for a structural error. */
	readonly ruleId: string;

	/** File and JSON pointer the problem sits at. */
	readonly location: string;
}

/** A document that could not be read, or that says something the wrapper cannot express. */
export class SpecError extends Error {
	override readonly name: string = "SpecError";

	/** Path or URL the document was read from. */
	readonly spec: string;

	constructor(message: string, init: { spec: string; cause?: unknown }) {
		super(message, { cause: init.cause });
		this.spec = init.spec;
	}
}

/**
 * A document that is not valid OpenAPI, or that references something missing.
 * `problems` holds every error found, so one run reports them all.
 */
export class SpecProblemsError extends SpecError {
	override readonly name = "SpecProblemsError";

	readonly problems: readonly SpecProblem[];

	constructor(spec: string, problems: readonly SpecProblem[]) {
		// The message is what reaches a terminal, so it shows the first few and
		// says how many are left. `problems` carries all of them.
		const shown = problems.slice(0, 10);
		const listed = shown
			.map((problem) => `  ${problem.location}: ${problem.message}`)
			.join("\n");
		const rest = problems.length - shown.length;
		const count = problems.length === 1 ? "1 problem" : `${problems.length} problems`;

		super(`${spec} has ${count}:\n${listed}${rest > 0 ? `\n  and ${rest} more` : ""}`, {
			spec,
		});
		this.problems = problems;
	}
}

/** A header sent when fetching the document itself. */
export interface SpecHeader {
	readonly name: string;

	readonly value: string;

	/**
	 * URL glob the header is sent to, matched by `@redocly/openapi-core`.
	 * Defaults to every URL the document reaches, which is what a single
	 * private host wants.
	 */
	readonly matches?: string;
}

export interface LoadOptions {
	/**
	 * Headers for fetching the document over http, such as a token for a
	 * private schema registry.
	 *
	 * Reading these from the environment in a config file is fine: this is a
	 * build-time tool, and the rule against environment reads covers the
	 * published package, whose generated code never sees them.
	 */
	readonly headers?: readonly SpecHeader[];
}

/** One OpenAPI document, in the two shapes the generator needs it in. */
export interface LoadedDocument {
	/** What the document says, reduced to what the emitter writes code from. */
	readonly model: NormalizedDocument;

	/**
	 * The same document with its references bundled, which is what
	 * `openapi-typescript` is handed. Passing the object rather than the path
	 * means the types and the model resolved every `$ref` through one resolver,
	 * so they cannot disagree.
	 */
	readonly bundled: unknown;
}

/**
 * Reads the OpenAPI document at `spec` and reduces it to the model the
 * generator writes code from.
 *
 * `spec` is a file path, resolved against the working directory, or an http
 * URL, which `options.headers` can carry a credential to. External and remote
 * `$ref`s are followed and pulled into `components.schemas`; internal ones are
 * left as pointers, because the schema names are what generated types alias
 * into.
 *
 * OpenAPI 3.0 and 3.1 are read. Webhooks and callbacks are left out, since
 * they describe calls arriving rather than calls the wrapper makes.
 *
 * @throws {SpecProblemsError} If the document is not valid OpenAPI or a `$ref`
 * does not resolve.
 * @throws {SpecError} If the document cannot be read, is an OpenAPI version
 * this generator does not read, or describes an endpoint the runtime's
 * `Operation` cannot express.
 */
export async function load(spec: string, options: LoadOptions = {}): Promise<LoadedDocument> {
	const config = await createConfig({
		rules: { struct: "error" },
		resolve: options.headers && {
			http: {
				headers: options.headers.map((header) => ({
					name: header.name,
					value: header.value,
					matches: header.matches ?? "**",
				})),
			},
		},
	});
	const resolver = new BaseResolver(config.resolve);

	let problems: readonly NormalizedProblem[];
	let parsed: unknown;
	try {
		// `lint` checks the document against the OpenAPI structure, `bundle`
		// reports references that do not resolve, and neither reports the
		// other's failures. They share a resolver, so each file is read once.
		const structure = await lint({ ref: spec, config, externalRefResolver: resolver });
		const bundled = await bundle({ ref: spec, config, externalRefResolver: resolver });
		problems = [...structure, ...bundled.problems];
		parsed = bundled.bundle.parsed;
	} catch (cause) {
		const reason = cause instanceof Error ? cause.message : String(cause);
		throw new SpecError(`Could not read an OpenAPI document from ${spec}: ${reason}`, {
			spec,
			cause,
		});
	}

	const fatal = problems.filter(isFatal);
	if (fatal.length > 0) {
		throw new SpecProblemsError(spec, fatal.map(toProblem));
	}

	const document = openApi3(spec, parsed);

	return { model: normalize({ ref: spec, document }), bundled: document };
}

/**
 * Whether a problem is one to stop for.
 *
 * A structural complaint about a schema is not this generator's business.
 * Schemas go to `openapi-typescript`, which reads what real documents contain
 * rather than what the specification says they may: Stripe's document alone
 * raises 618 of these (`nullable` with no `type`) and generates fine. The
 * parts this file does read, paths, parameters, responses and security
 * schemes, are still held to the structure.
 *
 * A reference that does not resolve is fatal wherever it sits, because
 * neither the types nor this model can invent the target.
 */
function isFatal(problem: NormalizedProblem): boolean {
	if (problem.severity !== "error") {
		return false;
	}
	if (problem.ruleId !== "struct") {
		return true;
	}

	const [first] = problem.location;
	const segments = first?.pointer?.split("/") ?? [];
	return !segments.includes("schema") && !segments.includes("schemas");
}

function toProblem(problem: NormalizedProblem): SpecProblem {
	const [first] = problem.location;
	const source = first ? `${first.source.absoluteRef}${first.pointer ?? ""}` : "";

	return { message: problem.message, ruleId: problem.ruleId, location: source };
}

/**
 * A document that has passed the `struct` rule, which is what makes `info` and
 * its title and version safe to read below.
 *
 * The 3.0 typings describe 3.1 documents just as well for everything this file
 * reads. The two versions differ inside schemas, which this file never opens:
 * it records where a schema lives and leaves the schema itself to
 * `openapi-typescript`.
 */
type OpenApiDocument = Oas3Definition & {
	readonly info: NonNullable<Oas3Definition["info"]>;
};

// The package's entry point re-exports only part of its OpenAPI typings. The
// rest are reached through the ones it does export.
type PathItem = Oas3PathItem;
type OperationObject = NonNullable<PathItem["get"]>;
type ParameterObject = Exclude<
	NonNullable<OperationObject["parameters"]>[number],
	OasRef
>;
type RequestBodyObject = Exclude<NonNullable<OperationObject["requestBody"]>, OasRef>;
type ResponseObject = NonNullable<OperationObject["responses"][string]>;
type ContentMap = NonNullable<ResponseObject["content"]>;
type MediaTypeObject = NonNullable<ContentMap[string]>;
type SchemaSlot = NonNullable<MediaTypeObject["schema"]>;
type SecuritySchemeObject = Exclude<
	NonNullable<NonNullable<Oas3Definition["components"]>["securitySchemes"]>[string],
	OasRef
>;
type ServerObject = NonNullable<Oas3Definition["servers"]>[number];

/** The bundled document and where it came from, which every step below needs. */
interface LoadedSpec {
	readonly ref: string;
	readonly document: OpenApiDocument;
}

/** Methods in the order operations are emitted, with the key a path item uses. */
const METHODS = [
	{ method: "GET", key: "get" },
	{ method: "POST", key: "post" },
	{ method: "PUT", key: "put" },
	{ method: "PATCH", key: "patch" },
	{ method: "DELETE", key: "delete" },
	{ method: "HEAD", key: "head" },
	{ method: "OPTIONS", key: "options" },
] as const satisfies readonly { method: HttpMethod; key: keyof PathItem }[];

function openApi3(spec: string, parsed: unknown): OpenApiDocument {
	let version: SpecVersion;
	try {
		version = detectSpec(parsed);
	} catch (cause) {
		throw new SpecError(`${spec} is not an API description this generator recognises`, {
			spec,
			cause,
		});
	}

	if (version !== SpecVersion.OAS3_0 && version !== SpecVersion.OAS3_1) {
		throw new SpecError(
			`${spec} is ${version}, and this generator reads OpenAPI 3.0 and 3.1. Convert the document to OpenAPI 3 first.`,
			{ spec }
		);
	}

	return parsed as OpenApiDocument;
}

function normalize(loaded: LoadedSpec): NormalizedDocument {
	const { document } = loaded;

	return {
		title: document.info.title,
		version: document.info.version,
		description: document.info.description,
		servers: (document.servers ?? []).map(toServer),
		security: document.security ?? [],
		securitySchemes: toSecuritySchemes(loaded),
		operations: toOperations(loaded),
	};
}

function toServer(server: ServerObject): SpecServer {
	return { url: serverUrl(server), description: server.description };
}

/**
 * Substitutes each server variable's default and drops any credentials in the
 * URL, which documents occasionally carry and which must not reach generated
 * documentation.
 */
function serverUrl(server: ServerObject): string {
	const substituted = server.url.replace(
		/\{([^{}]+)\}/gu,
		(placeholder, name: string) => server.variables?.[name]?.default ?? placeholder
	);

	let url: URL;
	try {
		url = new URL(substituted);
	} catch {
		// A server URL may be relative to where the document is served from.
		return substituted;
	}

	if (!url.username && !url.password) {
		return substituted;
	}

	url.username = "";
	url.password = "";
	return url.toString();
}

function toSecuritySchemes(loaded: LoadedSpec): readonly SpecSecurityScheme[] {
	const schemes = loaded.document.components?.securitySchemes ?? {};

	return byKey(schemes)
		.map(([name, scheme]) =>
			toSecurityScheme(loaded, name, resolveRef<SecuritySchemeObject>(loaded, scheme))
		);
}

function toSecurityScheme(
	loaded: LoadedSpec,
	name: string,
	scheme: SecuritySchemeObject
): SpecSecurityScheme {
	const shared = { name, description: scheme.description };

	switch (scheme.type) {
	case "http":
		return {
			...shared,
			kind: "http",
			scheme: declared(loaded, scheme.scheme, `scheme on security scheme ${name}`).toLowerCase(),
			bearerFormat: scheme.bearerFormat,
		};
	case "apiKey":
		return {
			...shared,
			kind: "apiKey",
			in: declared(loaded, scheme.in, `in on security scheme ${name}`),
			parameterName: declared(loaded, scheme.name, `name on security scheme ${name}`),
		};
	case "oauth2":
		return {
			...shared,
			kind: "oauth2",
			flows: toOAuthFlows(declared(loaded, scheme.flows, `flows on security scheme ${name}`)),
		};
	case "openIdConnect":
		return {
			...shared,
			kind: "openIdConnect",
			discoveryUrl: declared(
				loaded,
				scheme.openIdConnectUrl,
				`openIdConnectUrl on security scheme ${name}`
			),
		};
	case "mutualTLS":
		return { ...shared, kind: "mutualTLS" };
	}
}

function toOAuthFlows(
	flows: SecuritySchemeObject["flows"]
): SpecOAuth2Scheme["flows"] {
	const { implicit, password, clientCredentials, authorizationCode } = flows;

	return [
		implicit && { kind: "implicit" as const, ...implicit },
		password && { kind: "password" as const, ...password },
		clientCredentials && { kind: "clientCredentials" as const, ...clientCredentials },
		authorizationCode && { kind: "authorizationCode" as const, ...authorizationCode },
	].filter((flow) => flow !== undefined);
}

function toOperations(loaded: LoadedSpec): readonly SpecOperation[] {
	const operations: SpecOperation[] = [];

	for (const [path, reference] of byKey(loaded.document.paths ?? {})) {
		const item = resolveRef<PathItem>(loaded, reference);

		if (item.trace) {
			throw new SpecError(
				`TRACE ${path} in ${loaded.ref} cannot be wrapped, because the runtime's HttpMethod has no TRACE. Remove it from the document or write that endpoint by hand.`,
				{ spec: loaded.ref }
			);
		}

		for (const { method, key } of METHODS) {
			const operation = item[key];
			if (operation) {
				operations.push(toOperation(loaded, path, method, item, operation));
			}
		}
	}

	return operations;
}

function toOperation(
	loaded: LoadedSpec,
	path: string,
	method: HttpMethod,
	item: PathItem,
	operation: OperationObject
): SpecOperation {
	const declaredParameters = mergeParameters(loaded, item, operation);
	const inLocation = (location: string): readonly SpecParameter[] =>
		[...declaredParameters.values()]
			.filter((parameter) => parameter.in === location)
			.map(toParameter);

	return {
		method,
		path,
		operationId: operation.operationId,
		summary: operation.summary,
		description: operation.description,
		deprecated: operation.deprecated === true,
		tags: operation.tags ?? [],
		pathParameters: toPathParameters(loaded, path, method, declaredParameters),
		queryParameters: inLocation("query"),
		headerParameters: inLocation("header").filter(
			(parameter) => !IGNORED_HEADERS.has(parameter.name.toLowerCase())
		),
		cookieParameters: inLocation("cookie"),
		requestBody: toRequestBody(loaded, operation),
		successes: toSuccesses(loaded, operation),
		security: operation.security,
	};
}

/**
 * OpenAPI ignores a header parameter under one of these names, because the
 * media types and the security schemes already describe those headers. A
 * document that declares them anyway would otherwise put a `contentType`
 * argument on a function that sets its own.
 */
const IGNORED_HEADERS = new Set(["accept", "content-type", "authorization"]);

/**
 * Path-item parameters and the operation's own, keyed by location and name.
 * An operation's parameter replaces the path item's, and `Map.set` keeps the
 * position of a key it already holds, so the shared ones stay first.
 */
function mergeParameters(
	loaded: LoadedSpec,
	item: PathItem,
	operation: OperationObject
): ReadonlyMap<string, ParameterObject> {
	const merged = new Map<string, ParameterObject>();

	for (const reference of [...(item.parameters ?? []), ...(operation.parameters ?? [])]) {
		const parameter = resolveRef<ParameterObject>(loaded, reference);
		merged.set(`${parameter.in}:${parameter.name}`, parameter);
	}

	return merged;
}

const PATH_PARAMETER = /\{[^{}/]+\}/gu;

function toPathParameters(
	loaded: LoadedSpec,
	path: string,
	method: HttpMethod,
	declaredParameters: ReadonlyMap<string, ParameterObject>
): readonly SpecParameter[] {
	return [...path.matchAll(PATH_PARAMETER)].map((match) => {
		const name = match[0].slice(1, -1);
		const parameter = declaredParameters.get(`path:${name}`);

		if (!parameter) {
			throw new SpecError(
				`${method} ${path} in ${loaded.ref} takes a path parameter {${name}} that it never declares, so its type is unknown.`,
				{ spec: loaded.ref }
			);
		}

		return toParameter(parameter);
	});
}

function toParameter(parameter: ParameterObject): SpecParameter {
	const style = parameterStyle(parameter);

	return {
		name: parameter.name,
		// A path parameter is required whatever the document says, since the
		// path cannot be built without it.
		required: parameter.in === "path" || parameter.required === true,
		deprecated: parameter.deprecated === true,
		description: parameter.description,
		componentSchema: componentSchemaName(parameterSchema(parameter)),
		style,
		explode: parameter.explode ?? (style === "form"),
	};
}

/** OpenAPI's default is `form` in a query or a cookie and `simple` elsewhere. */
function parameterStyle(parameter: ParameterObject): ParameterStyle {
	if (parameter.style) {
		return parameter.style;
	}

	return parameter.in === "query" || parameter.in === "cookie" ? "form" : "simple";
}

/** A parameter carries either a schema or a single media type describing one. */
function parameterSchema(parameter: ParameterObject): SchemaSlot | undefined {
	return parameter.schema ?? selectMediaType(parameter.content ?? {})?.media.schema;
}

function toRequestBody(
	loaded: LoadedSpec,
	operation: OperationObject
): SpecRequestBody | undefined {
	if (!operation.requestBody) {
		return undefined;
	}

	const body = resolveRef<RequestBodyObject>(loaded, operation.requestBody);
	const selected = selectMediaType(body.content);

	if (!selected) {
		return undefined;
	}

	return {
		required: body.required === true,
		contentType: selected.contentType,
		description: body.description,
		componentSchema: componentSchemaName(selected.media.schema),
	};
}

const SUCCESS_STATUS = /^2(\d\d|xx)$/iu;

function toSuccesses(
	loaded: LoadedSpec,
	operation: OperationObject
): readonly SpecResponse[] {
	return Object.entries(operation.responses)
		.filter(([status]) => SUCCESS_STATUS.test(status))
		.sort(([left], [right]) => statusOrder(left) - statusOrder(right))
		.map(([status, reference]) => {
			const response = resolveRef<ResponseObject>(loaded, reference);
			const selected = selectMediaType(response.content ?? {});

			return {
				status,
				description: response.description,
				contentType: selected?.contentType,
				componentSchema: selected && componentSchemaName(selected.media.schema),
			};
		});
}

/** Numeric statuses in order, with a wildcard such as `2XX` after them. */
function statusOrder(status: string): number {
	return /^\d+$/u.test(status) ? Number(status) : Number.POSITIVE_INFINITY;
}

/**
 * Picks the one media type a generated function sends or reads: JSON first,
 * because that is what the wrapper serializes with `JSON.stringify`, then the
 * encodings `Request` builds itself, then whatever the document lists first.
 * An endpoint offering several is wrapped for one of them.
 */
function selectMediaType(
	content: ContentMap
): { contentType: string; media: MediaTypeObject } | undefined {
	const offered = Object.entries(content).map(([contentType, media]) => ({
		contentType,
		media,
	}));

	if (offered.length === 0) {
		return undefined;
	}

	return offered.reduce((best, entry) =>
		mediaTypeRank(entry.contentType) < mediaTypeRank(best.contentType) ? entry : best
	);
}

function mediaTypeRank(contentType: string): number {
	const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";

	if (type === "application/json") {
		return 0;
	}
	if (type.endsWith("+json")) {
		return 1;
	}
	if (type === "application/x-www-form-urlencoded") {
		return 2;
	}
	if (type === "multipart/form-data") {
		return 3;
	}
	return 4;
}

const COMPONENT_SCHEMA = "#/components/schemas/";

/**
 * The component name when a slot holds a direct `$ref` to one, which is what
 * lets a generated type alias `components["schemas"]["User"]` instead of
 * reaching through the `paths` tree. A pointer into a schema rather than at
 * one has no name to use, and reports none.
 */
function componentSchemaName(schema: SchemaSlot | undefined): string | undefined {
	if (!schema || !isRef(schema) || !schema.$ref.startsWith(COMPONENT_SCHEMA)) {
		return undefined;
	}

	const name = schema.$ref.slice(COMPONENT_SCHEMA.length);
	return name.includes("/") ? undefined : unescapePointer(name);
}

/**
 * Follows a local `$ref`. Bundling has already pulled external and remote
 * documents into `components`, so a pointer leaving the document is something
 * this generator cannot read.
 */
function resolveRef<T>(loaded: LoadedSpec, node: Referenced<T>): T {
	const followed = new Set<string>();
	let current: Referenced<T> = node;

	while (isRef(current)) {
		const { $ref: pointer } = current;

		if (!pointer.startsWith("#/")) {
			throw new SpecError(
				`${loaded.ref} still references ${pointer} after bundling, which this generator cannot follow.`,
				{ spec: loaded.ref }
			);
		}
		if (followed.has(pointer)) {
			throw new SpecError(`${loaded.ref} has a cycle of $ref pointers through ${pointer}.`, {
				spec: loaded.ref,
			});
		}
		followed.add(pointer);

		const target = pointer
			.slice(2)
			.split("/")
			.reduce<unknown>(
				(node, segment) =>
					isRecord(node) ? node[unescapePointer(segment)] : undefined,
				loaded.document
			);

		if (target === undefined) {
			throw new SpecError(`${loaded.ref} references ${pointer}, which is not in the document.`, {
				spec: loaded.ref,
			});
		}

		current = target as Referenced<T>;
	}

	return current;
}

/**
 * Reads a field the `struct` rule has already made required. It throws rather
 * than filling in a default, because a guessed credential name or token URL
 * would be documentation that sends the reader somewhere real and wrong.
 */
function declared<T>(loaded: LoadedSpec, value: T | undefined, what: string): T {
	if (value === undefined) {
		throw new SpecError(`${loaded.ref} is missing ${what}.`, { spec: loaded.ref });
	}

	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
