import { access } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import type { SpecHeader } from "./document.js";

/**
 * What `dungbeetle.config.ts` exports by default.
 *
 * Each key is a protocol the package wraps, and leaving a key out is how a
 * protocol is left out of the package: nothing is generated for it, its
 * subpath export is removed, and its runtime dependency is not needed. At
 * least one is required, since a package that wraps nothing has no reason to
 * be built.
 *
 * Paths inside the package are fixed by the template's own layout, so the
 * only questions left are which documents to read, where the runtime lives,
 * and the names the generator's rules get wrong.
 */
export interface GeneratorConfig {
	/** An HTTP API described by OpenAPI 3.0 or 3.1, exported from the package root. */
	readonly openapi?: OpenApiConfig;

	/** A JSON-RPC 2.0 API described by OpenRPC 1.x, exported from `/openrpc`. */
	readonly openrpc?: OpenRpcConfig;

	/** A gRPC API described by `.proto` files, exported from `/grpc`. */
	readonly grpc?: GrpcConfig;
}

export interface OpenApiConfig {
	/** Path or URL of the OpenAPI document, resolved against the config file. */
	readonly spec: string;

	/**
	 * Module exporting `Operation`, `RequestBody` and `readJson`. Left unset,
	 * generated modules import from `src/` next to them, which is what a copied
	 * runtime wants. Set it to a package name when the runtime is depended on
	 * rather than copied.
	 */
	readonly runtimeImport?: string;

	/** Module `openapi-typescript` writes to. Defaults to `../schema.js`. */
	readonly schemaImport?: string;

	/**
	 * Headers for fetching `spec` over http, for a document behind a private
	 * URL. Reading their values from `process.env` here is fine: this file runs
	 * at build time and never ships.
	 */
	readonly specHeaders?: readonly SpecHeader[];

	/**
	 * Function names to use instead of the ones the path gives, keyed by
	 * `"GET /users/{user_id}"`. This is the escape from a name the path rules
	 * read wrongly, and from two endpoints that want the same name.
	 */
	readonly names?: Readonly<Record<string, string>>;
}

export interface OpenRpcConfig {
	/** Path or URL of the OpenRPC document, resolved against the config file. */
	readonly spec: string;

	/**
	 * Headers for fetching `spec` over http. Every header goes to `spec`
	 * itself, so `matches` is refused here.
	 */
	readonly specHeaders?: readonly SpecHeader[];

	/**
	 * Function names to use instead of the camel-cased method name, keyed by
	 * the method name as the document spells it, such as `"eth_getBalance"`.
	 */
	readonly names?: Readonly<Record<string, string>>;
}

export interface GrpcConfig {
	/**
	 * Directory holding the `.proto` files, resolved against the config file.
	 * It is the import root: a file at `<protos>/users/v1/users.proto` is
	 * imported by other files as `users/v1/users.proto`.
	 */
	readonly protos: string;
}

/** A configuration file that is missing, or that does not export a usable config. */
export class ConfigError extends Error {
	override readonly name = "ConfigError";

	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
	}
}

export async function loadConfig(path: string): Promise<GeneratorConfig> {
	let module: { default?: unknown };
	try {
		module = (await import(pathToFileURL(path).href)) as { default?: unknown };
	} catch (cause) {
		const reason = cause instanceof Error ? cause.message : String(cause);
		throw new ConfigError(`Could not read ${path}: ${reason}`, { cause });
	}

	return validate(path, module.default);
}

const SECTIONS = {
	openapi: ["spec", "runtimeImport", "schemaImport", "specHeaders", "names"],
	openrpc: ["spec", "specHeaders", "names"],
	grpc: ["protos"],
} as const;

type Protocol = keyof typeof SECTIONS;

const EXAMPLE = "`export default { openapi: { spec: \"./openapi.yaml\" } };`";

/**
 * Checks a config object key by key. A misspelled key is refused rather than
 * ignored, because an ignored `nmaes` map generates names nobody chose and
 * says nothing about it.
 */
export function validate(path: string, config: unknown): GeneratorConfig {
	if (!isObject(config)) {
		throw new ConfigError(`${path} must export a default object, such as ${EXAMPLE}.`);
	}

	for (const key of Object.keys(config)) {
		if (!(key in SECTIONS)) {
			const hint = key === "spec" ? " `spec` now sits inside a protocol, as `openapi: { spec }`." : "";
			throw new ConfigError(
				`\`${key}\` in ${path} is not a configuration key. The keys are ${list(Object.keys(SECTIONS))}.${hint}`
			);
		}
	}

	const present = (Object.keys(SECTIONS) as Protocol[]).filter((key) => config[key] !== undefined);
	if (present.length === 0) {
		throw new ConfigError(
			`${path} configures no protocol. Add at least one of ${list(Object.keys(SECTIONS))}, such as ${EXAMPLE}.`
		);
	}

	for (const protocol of present) {
		const section = config[protocol];
		if (!isObject(section)) {
			throw new ConfigError(`\`${protocol}\` in ${path} must be an object.`);
		}
		const allowed: readonly string[] = SECTIONS[protocol];
		for (const key of Object.keys(section)) {
			if (!allowed.includes(key)) {
				throw new ConfigError(
					`\`${protocol}.${key}\` in ${path} is not a configuration key. The keys of \`${protocol}\` are ${list(allowed)}.`
				);
			}
		}
		const required = protocol === "grpc" ? "protos" : "spec";
		const value = section[required];
		if (typeof value !== "string" || value.length === 0) {
			throw new ConfigError(
				`\`${protocol}.${required}\` in ${path} must be ${protocol === "grpc" ? "a directory" : "a path or a URL"}.`
			);
		}
		if (section["names"] !== undefined) {
			names(path, protocol, section["names"]);
		}
		if (section["specHeaders"] !== undefined) {
			headers(path, protocol, section["specHeaders"]);
		}
	}

	return config as GeneratorConfig;
}

function names(path: string, protocol: Protocol, value: unknown): void {
	if (!isObject(value)) {
		throw new ConfigError(`\`${protocol}.names\` in ${path} must be an object of names.`);
	}
	for (const [key, name] of Object.entries(value)) {
		if (typeof name !== "string" || !/^[A-Za-z_$][\w$]*$/u.test(name)) {
			throw new ConfigError(
				`\`${protocol}.names[${JSON.stringify(key)}]\` in ${path} must be a JavaScript identifier, not ${JSON.stringify(name)}.`
			);
		}
	}
}

function headers(path: string, protocol: Protocol, value: unknown): void {
	const where = `\`${protocol}.specHeaders\` in ${path}`;
	if (!Array.isArray(value)) {
		throw new ConfigError(`${where} must be an array of \`{ name, value }\`.`);
	}
	for (const header of value) {
		if (!isObject(header) || typeof header["name"] !== "string" || typeof header["value"] !== "string") {
			throw new ConfigError(`${where} must be an array of \`{ name, value }\`, each a string.`);
		}
		// An OpenRPC document is one file, fetched once, and its references are
		// never followed out of it, so there is nothing for a glob to choose
		// between. Accepting one would suggest it narrowed something.
		if (protocol === "openrpc" && header["matches"] !== undefined) {
			throw new ConfigError(
				`${where} sets \`matches\`, which only OpenAPI uses. An OpenRPC document is fetched from one URL, so every header goes to it.`
			);
		}
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function list(keys: readonly string[]): string {
	return keys.map((key) => `\`${key}\``).join(", ");
}

/** The configuration a run reads, and where its `spec` came from. */
export interface ResolvedConfig {
	readonly config: GeneratorConfig;

	/** False when there was no file and `--spec` stood in for one. */
	readonly fromFile: boolean;
}

/**
 * The configuration for a run, with `openapi.spec` replaced where the
 * command line gave one.
 *
 * A missing file is only a failure when nothing replaces it: `--spec` on its
 * own is enough to generate, which is what lets the command run against a
 * document in a project that has no configuration yet. Where the file is
 * there, the flag replaces its `openapi.spec` and leaves the rest of it in force, so
 * the `names` a project has settled still apply to a document read from the
 * command line.
 */
export async function resolveConfig(
	path: string,
	spec: string | undefined
): Promise<ResolvedConfig> {
	if (spec !== undefined && !(await exists(path))) {
		return { config: { openapi: { spec } }, fromFile: false };
	}

	const config = await loadConfig(path);
	if (spec === undefined) {
		return { config, fromFile: true };
	}
	if (config.openapi === undefined) {
		throw new ConfigError(
			`--spec replaces \`openapi.spec\`, and ${path} configures no \`openapi\`.`
		);
	}

	return { config: { ...config, openapi: { ...config.openapi, spec } }, fromFile: true };
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
