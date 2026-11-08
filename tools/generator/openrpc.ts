import { readFile } from "node:fs/promises";

import openapiTS, { astToString, type OpenAPI3 } from "openapi-typescript";

import { SpecError, type SpecHeader } from "./document.js";
import { BANNER_MARK } from "./emit.js";
import { parameterName, typeName } from "./names.js";
import { compare } from "./order.js";
import { PlanError, type Collision } from "./plan.js";

// An OpenRPC document turned into one module per method namespace. The schema
// types go through `openapi-typescript` like the OpenAPI ones do: OpenRPC
// schemas are JSON Schema and live at `#/components/schemas`, which is where an
// OpenAPI 3.1 document keeps them too, so its references resolve unchanged.

/** One param or result, after any `$ref` to `components.contentDescriptors` is followed. */
export interface RpcDescriptor {
	/** Name as the API spells it, which is the key for by-name params. */
	readonly name: string;

	readonly summary?: string;

	readonly description?: string;

	readonly required: boolean;

	readonly deprecated: boolean;

	/** `components.schemas` key the schema refers to, when it is only a `$ref`. */
	readonly component?: string;

	/** The schema itself, when it is not only a `$ref` to a component. */
	readonly inline?: unknown;
}

export interface RpcMethod {
	readonly name: string;

	readonly summary?: string;

	readonly description?: string;

	readonly deprecated: boolean;

	/** `by-name` sends an object; `by-position` and `either` send an array. */
	readonly byName: boolean;

	readonly params: readonly RpcDescriptor[];

	readonly result: RpcDescriptor;

	/** Error codes and messages the document says this method can answer with. */
	readonly errors: readonly { readonly code: number; readonly message: string }[];
}

export interface RpcDocument {
	readonly title: string;

	readonly version: string;

	/** Sorted by name, so a re-run against an updated document gives a readable diff. */
	readonly methods: readonly RpcMethod[];

	/** Methods without a `result`, which are notifications this client does not send. */
	readonly notifications: readonly string[];

	/** `components.schemas`, as the document declares it. */
	readonly schemas: Readonly<Record<string, unknown>>;
}

/**
 * Reads the OpenRPC document at `spec`, a file path or an http URL.
 *
 * Only references inside the document are followed. OpenRPC documents are
 * JSON by definition, so YAML is not read.
 *
 * @throws {SpecError} If the document cannot be read, is not OpenRPC 1.x, or
 * holds a reference that does not resolve inside it.
 */
export async function loadRpc(
	spec: string,
	options: { readonly headers?: readonly SpecHeader[] } = {}
): Promise<RpcDocument> {
	let text: string;
	try {
		if (/^https?:/iu.test(spec)) {
			const response = await fetch(spec, {
				headers: (options.headers ?? []).map((header): [string, string] => [header.name, header.value]),
			});
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}
			text = await response.text();
		} else {
			text = await readFile(spec, "utf8");
		}
	} catch (cause) {
		const reason = cause instanceof Error ? cause.message : String(cause);
		throw new SpecError(`Could not read an OpenRPC document from ${spec}: ${reason}`, { spec, cause });
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (cause) {
		throw new SpecError(`${spec} is not JSON, which an OpenRPC document has to be.`, { spec, cause });
	}

	return normalize(spec, parsed);
}

function normalize(spec: string, document: unknown): RpcDocument {
	const fail = (where: string, problem: string): never => {
		throw new SpecError(`${spec}: ${where} ${problem}`, { spec });
	};

	if (!isObject(document)) {
		return fail("the document", "is not an object.");
	}
	if (typeof document["openrpc"] !== "string" || !/^1\.\d+\.\d+$/u.test(document["openrpc"])) {
		return fail("`openrpc`", "must name a 1.x version, such as \"1.3.2\".");
	}

	const info = document["info"];
	if (!isObject(info) || typeof info["title"] !== "string" || typeof info["version"] !== "string") {
		return fail("`info`", "must have a string `title` and `version`.");
	}

	const components = isObject(document["components"]) ? document["components"] : {};
	const schemas = isObject(components["schemas"]) ? components["schemas"] : {};
	const descriptors = isObject(components["contentDescriptors"]) ? components["contentDescriptors"] : {};

	const resolve = (where: string, value: unknown, kind: "contentDescriptors" | "errors"): unknown => {
		if (!isObject(value) || typeof value["$ref"] !== "string") {
			return value;
		}
		const prefix = `#/components/${kind}/`;
		const ref = value["$ref"];
		const table = kind === "errors" ? (isObject(components["errors"]) ? components["errors"] : {}) : descriptors;
		const target = ref.startsWith(prefix) ? table[decodeRef(ref.slice(prefix.length))] : undefined;

		return target ?? fail(where, `refers to ${ref}, which this document does not declare.`);
	};

	const checkRefs = (where: string, value: unknown): void => {
		if (Array.isArray(value)) {
			value.forEach((item, index) => checkRefs(`${where}[${index}]`, item));
			return;
		}
		if (!isObject(value)) {
			return;
		}
		const ref = value["$ref"];
		if (typeof ref === "string") {
			const prefix = "#/components/schemas/";
			if (!ref.startsWith(prefix) || !(decodeRef(ref.slice(prefix.length)) in schemas)) {
				fail(where, `refers to ${ref}; only \`#/components/schemas/\` entries this document declares are followed.`);
			}
		}
		for (const [key, child] of Object.entries(value)) {
			checkRefs(`${where}.${key}`, child);
		}
	};

	const descriptor = (where: string, raw: unknown): RpcDescriptor => {
		const value = resolve(where, raw, "contentDescriptors");
		if (!isObject(value) || typeof value["name"] !== "string" || value["name"].length === 0) {
			return fail(where, "must be a content descriptor with a `name`.");
		}
		if (!("schema" in value)) {
			return fail(where, "has no `schema`.");
		}
		const schema = value["schema"];
		checkRefs(`${where}.schema`, schema);
		const component =
			isObject(schema) && Object.keys(schema).length === 1 && typeof schema["$ref"] === "string"
				? decodeRef(schema["$ref"].slice("#/components/schemas/".length))
				: undefined;

		return {
			name: value["name"],
			summary: text(value["summary"]),
			description: text(value["description"]),
			required: value["required"] === true,
			deprecated: value["deprecated"] === true,
			component,
			inline: component === undefined ? schema : undefined,
		};
	};

	for (const [name, schema] of Object.entries(schemas)) {
		checkRefs(`components.schemas.${name}`, schema);
	}

	if (!Array.isArray(document["methods"])) {
		return fail("`methods`", "must be an array.");
	}

	const methods: RpcMethod[] = [];
	const notifications: string[] = [];
	const seen = new Set<string>();

	document["methods"].forEach((raw: unknown, index) => {
		const where = `methods[${index}]`;
		if (!isObject(raw) || typeof raw["name"] !== "string" || raw["name"].length === 0) {
			return fail(where, "must be a method with a `name`. References to methods are not followed.");
		}
		const name = raw["name"];
		if (seen.has(name)) {
			return fail(where, `repeats the method name ${JSON.stringify(name)}.`);
		}
		seen.add(name);

		if (!Array.isArray(raw["params"])) {
			return fail(`${where} (${name})`, "must have a `params` array.");
		}
		const params = raw["params"].map((param: unknown, at) => descriptor(`${where}.params[${at}]`, param));

		const names = new Set<string>();
		let optional = false;
		for (const param of params) {
			if (names.has(param.name)) {
				return fail(`${where} (${name})`, `has two params named ${JSON.stringify(param.name)}.`);
			}
			names.add(param.name);
			// The specification requires this for by-position, and a client
			// cannot send a required param at a position after an absent one.
			if (param.required && optional) {
				return fail(`${where} (${name})`, `lists the required param ${JSON.stringify(param.name)} after an optional one.`);
			}
			optional ||= !param.required;
		}

		const structure = raw["paramStructure"] ?? "either";
		if (structure !== "by-name" && structure !== "by-position" && structure !== "either") {
			return fail(`${where} (${name})`, "has a `paramStructure` that is not by-name, by-position or either.");
		}

		if (raw["result"] === undefined) {
			notifications.push(name);
			return;
		}

		const errors = (Array.isArray(raw["errors"]) ? raw["errors"] : []).map((error: unknown, at) => {
			const value = resolve(`${where}.errors[${at}]`, error, "errors");
			if (!isObject(value) || typeof value["code"] !== "number" || typeof value["message"] !== "string") {
				return fail(`${where}.errors[${at}]`, "must have a numeric `code` and a string `message`.");
			}
			return { code: value["code"], message: value["message"] };
		});

		methods.push({
			name,
			summary: text(raw["summary"]),
			description: text(raw["description"]),
			deprecated: raw["deprecated"] === true,
			byName: structure === "by-name",
			params,
			result: descriptor(`${where}.result`, raw["result"]),
			errors,
		});
	});

	return {
		title: info["title"],
		version: info["version"],
		methods: methods.sort((left, right) => compare(left.name, right.name)),
		notifications: notifications.sort(compare),
		schemas,
	};
}

/** A JSON pointer segment, unescaped. */
function decodeRef(segment: string): string {
	return decodeURIComponent(segment).replaceAll("~1", "/").replaceAll("~0", "~");
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

// Planning: every name settled before any source is written.

export interface RpcPlan {
	readonly modules: readonly RpcModule[];

	/** Component schemas, exported as aliases from `types.ts`. */
	readonly schemas: readonly { readonly name: string; readonly component: string }[];
}

export interface RpcModule {
	/** File name under `src/methods/`, without the extension. */
	readonly name: string;

	readonly methods: readonly PlannedMethod[];
}

export interface PlannedMethod {
	readonly spec: RpcMethod;

	readonly name: string;

	/** Exported params interface, absent when the method takes none. */
	readonly paramsType?: string;

	readonly resultType: string;
}

/**
 * The module a method is written to: its namespace, the part before the first
 * `_` or `.`, which is how JSON-RPC APIs group methods (`eth_getBalance`,
 * `rpc.discover`). A method without one goes to `methods`.
 */
export function rpcModuleName(method: string): string {
	const match = /^([A-Za-z][A-Za-z0-9]*)[_.](?=.)/u.exec(method);

	return match?.[1] === undefined ? "methods" : match[1].toLowerCase();
}

export function planRpc(
	document: RpcDocument,
	options: { readonly names?: Readonly<Record<string, string>> } = {}
): RpcPlan {
	const known = new Set(document.methods.map((method) => method.name));
	const stray = Object.keys(options.names ?? {}).filter((key) => !known.has(key)).sort(compare);
	if (stray.length > 0) {
		throw new PlanError(
			`\`openrpc.names\` renames methods the document does not have: ${stray.map((key) => JSON.stringify(key)).join(", ")}.`
		);
	}

	const held = new Map<string, string>();
	const collisions: Collision[] = [];
	const claim = (name: string, by: string, signature: string): void => {
		const holder = held.get(name);
		if (holder === undefined) {
			held.set(name, by);
		} else {
			collisions.push({ signature, wanted: name, held: holder });
		}
	};

	const schemas = Object.keys(document.schemas)
		.sort(compare)
		.map((component) => ({ name: typeName(component), component }));
	for (const schema of schemas) {
		claim(schema.name, `components.schemas.${schema.component}`, `components.schemas.${schema.component}`);
	}

	const grouped = new Map<string, PlannedMethod[]>();
	for (const method of document.methods) {
		const name = options.names?.[method.name] ?? parameterName(method.name);
		const pascal = `${name.slice(0, 1).toUpperCase()}${name.slice(1)}`;
		const planned: PlannedMethod = {
			spec: method,
			name,
			paramsType: method.params.length > 0 ? `${pascal}Params` : undefined,
			resultType: method.result.component === undefined ? `${pascal}Result` : typeName(method.result.component),
		};

		claim(name, method.name, method.name);
		if (planned.paramsType !== undefined) {
			claim(planned.paramsType, method.name, method.name);
		}
		if (method.result.component === undefined) {
			claim(planned.resultType, method.name, method.name);
		}

		const module = rpcModuleName(method.name);
		grouped.set(module, [...(grouped.get(module) ?? []), planned]);
	}

	if (collisions.length > 0) {
		const lines = collisions.map(
			(collision) => `  ${collision.signature} wants ${collision.wanted}, which ${collision.held} already has`
		);
		throw new PlanError(
			[
				`${collisions.length === 1 ? "1 name is" : `${collisions.length} names are`} taken twice:`,
				...lines,
				"Rename the method under `openrpc.names` in the config, keyed by its method name.",
			].join("\n"),
			collisions
		);
	}

	const modules = [...grouped]
		.sort(([left], [right]) => compare(left, right))
		.map(([name, methods]) => ({ name, methods }));

	return { modules, schemas };
}

// Emitting.

/** Key under the synthetic `components.schemas` an inline schema is typed through. */
function inlineKey(method: RpcMethod, descriptor: RpcDescriptor, role: "params" | "result"): string {
	return role === "result" ? `${method.name}:result` : `${method.name}:params:${descriptor.name}`;
}

/**
 * The source of `src/rpc-schema.ts`: the document's schemas, and every inline
 * param and result schema under a key no component can have, typed by
 * `openapi-typescript` as an OpenAPI 3.1 document with no paths.
 */
export async function emitRpcSchema(document: RpcDocument, spec: string): Promise<string> {
	const schemas: Record<string, unknown> = { ...document.schemas };
	for (const method of document.methods) {
		for (const param of method.params) {
			if (param.component === undefined) {
				schemas[inlineKey(method, param, "params")] = param.inline;
			}
		}
		if (method.result.component === undefined) {
			schemas[inlineKey(method, method.result, "result")] = method.result.inline;
		}
	}

	const ast = await openapiTS(
		{
			openapi: "3.1.0",
			info: { title: document.title, version: document.version },
			paths: {},
			components: { schemas },
		} as OpenAPI3,
		{ immutable: true }
	);

	return [
		`// ${BANNER_MARK} from ${spec}. Do not edit.`,
		"//",
		"// Every schema the OpenRPC document declares or uses inline. Method modules",
		"// alias into it, so a name here is only public where one of them exports it.",
		"",
		astToString(ast),
	].join("\n");
}

function banner(spec: string): string {
	return [
		`// ${BANNER_MARK} from ${spec}. Do not edit.`,
		"//",
		"// Re-running the generator rewrites this file.",
	].join("\n");
}

/** The source of `src/methods/types.ts`, which names the document's component schemas. */
export function emitRpcTypes(plan: RpcPlan, spec: string): string {
	const aliases = plan.schemas.map(
		(schema) =>
			`/** \`components.schemas.${schema.component}\` as the document declares it. */\nexport type ${schema.name} = components["schemas"][${JSON.stringify(schema.component)}];`
	);

	return [banner(spec), "import type { components } from \"../rpc-schema.js\";", ...aliases].join("\n\n") + "\n";
}

/** The source of one method module. */
export function emitRpcModule(module: RpcModule, spec: string): string {
	const used = new Set<string>();
	const typeOf = (method: RpcMethod, descriptor: RpcDescriptor, role: "params" | "result"): string => {
		if (descriptor.component !== undefined) {
			const name = typeName(descriptor.component);
			used.add(name);
			return name;
		}
		return `components["schemas"][${JSON.stringify(inlineKey(method, descriptor, role))}]`;
	};

	const blocks = module.methods.map((planned) => emitMethod(planned, typeOf));
	const inline = blocks.some((block) => block.includes("components[\"schemas\"]"));
	const runtime = module.methods.some((planned) => !planned.spec.byName && planned.spec.params.length > 0)
		? "import { positional, type RpcCall } from \"../rpc.js\";"
		: "import type { RpcCall } from \"../rpc.js\";";

	const imports = [
		runtime,
		inline ? "import type { components } from \"../rpc-schema.js\";" : undefined,
		used.size > 0 ? `import type { ${[...used].sort(compare).join(", ")} } from "./types.js";` : undefined,
	].filter((line) => line !== undefined);

	return `${[banner(spec), imports.join("\n"), ...blocks].join("\n\n")}\n`;
}

function emitMethod(
	planned: PlannedMethod,
	typeOf: (method: RpcMethod, descriptor: RpcDescriptor, role: "params" | "result") => string
): string {
	const { spec } = planned;
	const blocks: string[] = [];

	if (planned.paramsType !== undefined) {
		const properties = spec.params.map((param, index) => {
			const doc = [param.summary, param.description, param.deprecated ? "@deprecated" : undefined]
				.filter((part) => part !== undefined)
				.join("\n\n");
			const spacing = doc.length > 0 && index > 0 ? "\n" : "";
			const documentation = doc.length > 0 ? `${comment(doc, "\t")}\n` : "";
			const optional = param.required ? "" : "?";
			return `${spacing}${documentation}\treadonly ${parameterName(param.name)}${optional}: ${typeOf(spec, param, "params")};`;
		});
		blocks.push(
			[`/** Params accepted by {@link ${planned.name}}. */`, `export interface ${planned.paramsType} {`, ...properties, "}"].join("\n")
		);
	}

	const result = typeOf(spec, spec.result, "result");
	if (spec.result.component === undefined) {
		blocks.push(`/** What {@link ${planned.name}} resolves to. */\nexport type ${planned.resultType} = ${result};`);
	}

	const required = spec.params.some((param) => param.required);
	const argument =
		planned.paramsType === undefined ? "" : `params: ${planned.paramsType}${required ? "" : " = {}"}`;
	const values = spec.params.map((param) => `params.${parameterName(param.name)}`);
	const params =
		spec.params.length === 0
			? undefined
			: spec.byName
				? [
					"\t\tparams: {",
					...spec.params.map((param, index) => `\t\t\t${propertyKey(param.name)}: ${values[index]},`),
					"\t\t},",
				].join("\n")
				: `\t\tparams: positional([${values.join(", ")}]),`;

	const doc = [
		`\`${spec.name}\``,
		spec.summary,
		spec.description,
		...spec.errors.map((error) => `@throws {RpcError} ${error.code}: ${error.message}`),
		spec.deprecated ? "@deprecated" : undefined,
	]
		.filter((part) => part !== undefined)
		.join("\n\n");

	blocks.push(
		[
			comment(doc, ""),
			`export function ${planned.name}(${argument}): RpcCall<${planned.resultType}> {`,
			"\treturn {",
			`\t\tmethod: ${JSON.stringify(spec.name)},`,
			params,
			"\t};",
			"}",
		]
			.filter((line) => line !== undefined)
			.join("\n")
	);

	return blocks.join("\n\n");
}

function propertyKey(name: string): string {
	return /^[A-Za-z_$][\w$]*$/u.test(name) ? name : JSON.stringify(name);
}

function comment(text: string, indent: string): string {
	const lines = text.replaceAll("*/", "*\\/").split("\n");
	if (lines.length === 1) {
		return `${indent}/** ${lines[0]} */`;
	}
	return [`${indent}/**`, ...lines.map((line) => (line.length > 0 ? `${indent} * ${line}` : `${indent} *`)), `${indent} */`].join("\n");
}

/** Every value and type a plan exports, for the barrel and the surface test. */
export function rpcExports(plan: RpcPlan): { values: readonly string[]; types: readonly string[] } {
	const methods = plan.modules.flatMap((module) => module.methods);

	return {
		values: methods.map((method) => method.name).sort(compare),
		types: [
			...plan.schemas.map((schema) => schema.name),
			...methods.flatMap((method) => [
				method.paramsType,
				method.spec.result.component === undefined ? method.resultType : undefined,
			]),
		]
			.filter((name) => name !== undefined)
			.sort(compare),
	};
}
