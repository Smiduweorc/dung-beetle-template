import type { HttpMethod } from "../../src/operation.js";

/**
 * What one OpenAPI document says, reduced to the facts a resource module is
 * written from. `document.ts` builds it; everything downstream reads this and
 * never sees the OpenAPI document itself, so changing parser touches one file.
 *
 * Names here stay in the API's vocabulary: wire parameter names, media types
 * and response keys exactly as the spec writes them. Turning those into
 * TypeScript names is the emitter's job, and the one part of this project that
 * carries an opinion.
 */
export interface NormalizedDocument {
	/** `info.title`. */
	readonly title: string;

	/** `info.version`, which is the API's version and not the OpenAPI version. */
	readonly version: string;

	readonly description?: string;

	/** In the order the document lists them. */
	readonly servers: readonly SpecServer[];

	/**
	 * Document-level `security`. An operation that declares none of its own
	 * requires one of these instead.
	 */
	readonly security: readonly SpecSecurityRequirement[];

	/** Sorted by name. */
	readonly securitySchemes: readonly SpecSecurityScheme[];

	/**
	 * Sorted by path, then by method in {@link HttpMethod} order, so a re-run
	 * against an updated document produces a readable diff.
	 */
	readonly operations: readonly SpecOperation[];
}

/** One entry from `servers`, for documentation: the client takes its `baseUrl` as an option. */
export interface SpecServer {
	/** Variables replaced with their defaults, and any embedded credentials stripped. */
	readonly url: string;

	readonly description?: string;
}

/** One endpoint: a path and a method the wrapper can call. */
export interface SpecOperation {
	readonly method: HttpMethod;

	/** Path template as the document writes it, `/users/{user_id}`, uninterpolated. */
	readonly path: string;

	/**
	 * Kept for traceability only. Function names come from the method and the
	 * path, because real documents emit `read_user_users__user_id__get`.
	 */
	readonly operationId?: string;

	readonly summary?: string;
	readonly description?: string;
	readonly deprecated: boolean;
	readonly tags: readonly string[];

	/**
	 * In the order they appear in `path`, which is the order the generated
	 * function takes them. Always required, since a path cannot be built
	 * without them.
	 */
	readonly pathParameters: readonly SpecParameter[];

	/** Path-item parameters first, then the operation's own. */
	readonly queryParameters: readonly SpecParameter[];
	readonly headerParameters: readonly SpecParameter[];

	/** Browsers refuse to set `cookie` through `fetch`, which the emitter has to say out loud. */
	readonly cookieParameters: readonly SpecParameter[];

	readonly requestBody?: SpecRequestBody;

	/**
	 * Every 2xx response, ordered by status with wildcards last. Error
	 * responses are left out: the wrapper reports those as an `HttpError`
	 * carrying the raw body, so their schemas would type nothing.
	 */
	readonly successes: readonly SpecResponse[];

	/**
	 * `undefined` means the document-level `security` applies. An empty array
	 * is the document saying this one endpoint needs no credentials, which is
	 * worth documenting on the generated function.
	 */
	readonly security?: readonly SpecSecurityRequirement[];
}

/** One parameter, in whichever place the document puts it. */
export interface SpecParameter {
	/** Name on the wire. */
	readonly name: string;

	readonly required: boolean;
	readonly deprecated: boolean;
	readonly description?: string;

	/** Set when the parameter's schema is a direct `$ref` into `components.schemas`. */
	readonly componentSchema?: string;

	/** Resolved to the OpenAPI default for the parameter's location if the document leaves it out. */
	readonly style: ParameterStyle;

	/**
	 * Resolved to the OpenAPI default. `buildUrl` sends an array as one
	 * repeated key, which is `form` with `explode: true`; every other
	 * combination needs the emitter to serialize the value itself.
	 */
	readonly explode: boolean;
}

/** Serialization styles OpenAPI defines for parameters. */
export type ParameterStyle =
	| "matrix"
	| "label"
	| "form"
	| "simple"
	| "spaceDelimited"
	| "pipeDelimited"
	| "deepObject";

/** The one media type of a request body the generated function sends. */
export interface SpecRequestBody {
	readonly required: boolean;

	/**
	 * Media type key exactly as the document writes it. Chosen from what the
	 * endpoint accepts, JSON first, then a form encoding, then whatever comes
	 * first; an endpoint offering several is only wrapped for one of them.
	 */
	readonly contentType: string;

	readonly description?: string;

	/** Set when the media type's schema is a direct `$ref` into `components.schemas`. */
	readonly componentSchema?: string;
}

/** One 2xx response. */
export interface SpecResponse {
	/** Response key as the document writes it: `200`, or a wildcard such as `2XX`. */
	readonly status: string;

	readonly description?: string;

	/**
	 * Absent when the response declares no content, which is the case
	 * `decode: async () => undefined` exists for.
	 */
	readonly contentType?: string;

	/** Set when the media type's schema is a direct `$ref` into `components.schemas`. */
	readonly componentSchema?: string;
}

/**
 * One alternative from a `security` list, mapping a scheme name to the scopes
 * it needs. Every scheme within one requirement applies together, and the list
 * of requirements is a choice between them.
 */
export type SpecSecurityRequirement = Readonly<Record<string, readonly string[]>>;

/**
 * A declared security scheme. The generator documents these and emits no code
 * for them: a credential is a header, and headers already reach the client
 * through its options.
 */
export type SpecSecurityScheme =
	| SpecHttpScheme
	| SpecApiKeyScheme
	| SpecOAuth2Scheme
	| SpecOpenIdConnectScheme
	| SpecMutualTlsScheme;

interface SpecSecuritySchemeBase {
	/** Key under `components.securitySchemes`, which is what a `security` list refers to. */
	readonly name: string;

	readonly description?: string;
}

/** An `Authorization` header carrying an RFC 7235 scheme. */
export interface SpecHttpScheme extends SpecSecuritySchemeBase {
	readonly kind: "http";

	/** Lowercased scheme name: `bearer`, `basic`, `digest`. */
	readonly scheme: string;

	readonly bearerFormat?: string;
}

/** A credential sent under a name only the document knows. */
export interface SpecApiKeyScheme extends SpecSecuritySchemeBase {
	readonly kind: "apiKey";

	readonly in: "header" | "query" | "cookie";

	/**
	 * Exact name the credential is sent under. `X-API-Key` against `api-key`
	 * against `apikey` is a real debugging session, and the document is the
	 * only place that answer exists.
	 */
	readonly parameterName: string;
}

export interface SpecOAuth2Scheme extends SpecSecuritySchemeBase {
	readonly kind: "oauth2";

	/** In a fixed order: implicit, password, clientCredentials, authorizationCode. */
	readonly flows: readonly SpecOAuthFlow[];
}

export interface SpecOpenIdConnectScheme extends SpecSecuritySchemeBase {
	readonly kind: "openIdConnect";

	readonly discoveryUrl: string;
}

export interface SpecMutualTlsScheme extends SpecSecuritySchemeBase {
	readonly kind: "mutualTLS";
}

/** Where to go to get a token, as documentation. Fetching one is the consumer's business. */
export interface SpecOAuthFlow {
	readonly kind:
		| "implicit"
		| "password"
		| "clientCredentials"
		| "authorizationCode";

	readonly authorizationUrl?: string;
	readonly tokenUrl?: string;
	readonly refreshUrl?: string;

	/** Scope name to its description. */
	readonly scopes: Readonly<Record<string, string>>;
}
