import { pathToFileURL } from "node:url";

import type { SpecHeader } from "./document.js";

/**
 * What `dungbeetle.config.ts` exports by default.
 *
 * Paths inside the package are fixed by the template's own layout
 * (`src/resources/`, `src/schema.ts`, `index.ts`), so the only questions left
 * are which document to read, where the runtime lives, and the names the path
 * rules get wrong.
 */
export interface GeneratorConfig {
	/** Path or URL of the OpenAPI document, resolved against this file. */
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

	const config = module.default;

	if (typeof config !== "object" || config === null || !("spec" in config)) {
		throw new ConfigError(
			`${path} must export a default object with a \`spec\`, such as \`export default { spec: "./openapi.yaml" };\`.`
		);
	}

	const { spec, runtimeImport, schemaImport, specHeaders, names } = config as GeneratorConfig;

	if (typeof spec !== "string" || spec.length === 0) {
		throw new ConfigError(`\`spec\` in ${path} must be a path or a URL.`);
	}

	return { spec, runtimeImport, schemaImport, specHeaders, names };
}
