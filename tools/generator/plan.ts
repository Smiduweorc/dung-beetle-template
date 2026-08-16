import type {
	NormalizedDocument,
	SpecOperation,
	SpecParameter,
	SpecResponse,
} from "./model.js";
import { functionName, moduleName, typeName } from "./names.js";
import { compare } from "./order.js";

// Decides every name before a line of source is written, because a name has to
// be unique across the whole package: `index.ts` re-exports all of them into
// one namespace.

/** A document turned into the modules to write, with every name settled. */
export interface Plan {
	readonly modules: readonly PlannedModule[];
}

/** One file under `src/resources/`. */
export interface PlannedModule {
	/** Module name without an extension, which is also the file name. */
	readonly name: string;

	readonly operations: readonly PlannedOperation[];

	/** Component schemas this module declares, in the order they are written. */
	readonly schemas: readonly PlannedSchema[];

	/** Component schemas another module declares and this one imports. */
	readonly borrowed: readonly BorrowedSchema[];
}

export interface PlannedSchema {
	/** Exported type name. */
	readonly name: string;

	/** Key under `components.schemas` it aliases. */
	readonly component: string;
}

export interface BorrowedSchema {
	readonly name: string;

	/** Module that declares it. */
	readonly from: string;
}

/** One endpoint, with every name and type decision made. */
export interface PlannedOperation {
	readonly spec: SpecOperation;

	/** Exported function name. */
	readonly name: string;

	/** Exported interface for the query string, when the endpoint takes one. */
	readonly queryType?: string;

	/** Type of the request body, exported when it is not a component alias. */
	readonly bodyType?: { readonly name: string; readonly declared: boolean };

	/** Type the operation resolves to, exported when it is not a component alias. */
	readonly resultType: { readonly name: string; readonly declared: boolean };

	/** 2xx responses carrying a body, which is what the result type is built from. */
	readonly contentResponses: readonly SpecResponse[];

	/** 2xx responses with no body, which decide whether a `decode` is written. */
	readonly emptyResponses: readonly SpecResponse[];

	/**
	 * Query parameters whose serialisation this client cannot build at all,
	 * named in the function's documentation so the reader knows before calling.
	 */
	readonly awkwardQuery: readonly string[];
}

export interface PlanOptions {
	/** Function names to use instead of the ones the path would give, keyed `"GET /users/{id}"`. */
	readonly names?: Readonly<Record<string, string>>;
}

/** A name the generator cannot settle on its own. */
export class PlanError extends Error {
	override readonly name = "PlanError";

	/** Every endpoint that wanted a name something else holds. */
	readonly collisions: readonly Collision[];

	constructor(message: string, collisions: readonly Collision[] = []) {
		super(message);
		this.collisions = collisions;
	}
}

/** One endpoint whose name is already taken, and what took it. */
export interface Collision {
	/** The `"GET /users"` key the `names` map uses. */
	readonly signature: string;

	readonly wanted: string;

	/** What already holds the name. */
	readonly held: string;
}

export function plan(document: NormalizedDocument, options: PlanOptions = {}): Plan {
	const grouped = new Map<string, SpecOperation[]>();

	for (const operation of document.operations) {
		const module = moduleName(operation);
		const existing = grouped.get(module);

		if (existing) {
			existing.push(operation);
		} else {
			grouped.set(module, [operation]);
		}
	}

	// Exported names share one namespace, so they are handed out in a fixed
	// order: modules by name, operations as the document model sorted them.
	const taken = new Set<string>();
	const holders = new Map<string, string>();
	const owners = schemaOwners(grouped, taken, holders);
	const modules: PlannedModule[] = [];
	const collisions: Collision[] = [];
	const { collections, qualifiers } = pathContext(document);

	for (const [name, operations] of [...grouped].sort(([left], [right]) => compare(left, right))) {
		const borrowed = new Map<string, string>();
		const planned = operations.map((operation) =>
			planOperation(operation, {
				name,
				owners,
				taken,
				borrowed,
				options,
				collections,
				qualifiers,
				collisions,
				holders,
			})
		);

		modules.push({
			name,
			operations: planned,
			schemas: [...owners]
				.filter(([, owner]) => owner.module === name)
				.map(([component, owner]) => ({ name: owner.name, component }))
				.sort((left, right) => compare(left.name, right.name)),
			borrowed: [...borrowed]
				.map(([schemaName, from]) => ({ name: schemaName, from }))
				.sort((left, right) => compare(left.name, right.name)),
		});
	}

	if (collisions.length > 0) {
		throw new PlanError(collisionMessage(collisions), collisions);
	}

	return { modules };
}

/**
 * Every colliding name in one message, with a block to paste into the config.
 * Real documents collide a handful of times each (Stripe 6 of 589 endpoints,
 * GitHub 37 of 1220), and reporting them one run at a time would mean running
 * the generator once per collision.
 */
function collisionMessage(collisions: readonly Collision[]): string {
	const counted =
		collisions.length === 1 ? "1 endpoint wants a name" : `${collisions.length} endpoints want names`;
	const listed = collisions.map(
		(collision) => `  ${collision.signature} wants ${collision.wanted}, held by ${collision.held}`
	);
	const block = [
		"names: {",
		...collisions.map((collision) => `\t${JSON.stringify(collision.signature)}: "",`),
		"},",
	];

	return [
		`${counted} that something else already has:`,
		...listed,
		"",
		"Fill these in under `names` in the config:",
		...block,
	].join("\n");
}

/**
 * What the document as a whole says about each path: which paths are
 * collections because items hang off them, and which end in a parameter that
 * only qualifies an item the document already addresses.
 */
function pathContext(document: NormalizedDocument): {
	collections: ReadonlySet<string>;
	qualifiers: ReadonlyMap<string, string>;
} {
	const paths = new Set(document.operations.map((operation) => operation.path));
	const collections = new Set<string>();
	const qualifiers = new Map<string, string>();

	for (const path of paths) {
		const parent = path.slice(0, path.lastIndexOf("/"));
		const last = path.slice(parent.length + 1);

		if (!last.startsWith("{") || !paths.has(parent)) {
			continue;
		}
		if (parent.endsWith("}")) {
			// `/gists/{gist_id}/{sha}` on top of `/gists/{gist_id}`: one item, and
			// a second parameter picking something out of it.
			qualifiers.set(path, last.slice(1, -1));
		} else {
			collections.add(parent);
		}
	}

	return { collections, qualifiers };
}

interface SchemaOwner {
	readonly module: string;
	readonly name: string;
}

/**
 * Picks the one module that declares each component schema. Two modules
 * returning `User` would export the same name twice from `index.ts`, so the
 * first module to use it declares it and the others import it from there.
 */
function schemaOwners(
	grouped: ReadonlyMap<string, readonly SpecOperation[]>,
	taken: Set<string>,
	holders: Map<string, string>
): ReadonlyMap<string, SchemaOwner> {
	const owners = new Map<string, SchemaOwner>();

	for (const [module, operations] of [...grouped].sort(([left], [right]) =>
		compare(left, right)
	)) {
		for (const operation of operations) {
			for (const component of componentsOf(operation)) {
				if (!owners.has(component)) {
					const name = reserve(taken, typeName(component));

					owners.set(component, { module, name });
					holders.set(name, `the schema \`${component}\``);
				}
			}
		}
	}

	return owners;
}

function componentsOf(operation: SpecOperation): readonly string[] {
	return [
		operation.requestBody?.componentSchema,
		...operation.successes.map((response) => response.componentSchema),
	].filter((component) => component !== undefined);
}

interface OperationContext {
	readonly name: string;
	readonly owners: ReadonlyMap<string, SchemaOwner>;
	readonly taken: Set<string>;
	readonly borrowed: Map<string, string>;
	readonly options: PlanOptions;
	readonly collections: ReadonlySet<string>;
	readonly qualifiers: ReadonlyMap<string, string>;
	readonly collisions: Collision[];

	/** What each taken name belongs to, so a collision can say what it lost to. */
	readonly holders: Map<string, string>;
}

function heldBy(context: OperationContext, name: string): string {
	return context.holders.get(name) ?? "another generated name";
}

function planOperation(
	operation: SpecOperation,
	context: OperationContext
): PlannedOperation {
	const signature = `${operation.method} ${operation.path}`;
	const wanted =
		context.options.names?.[signature] ??
		functionName(operation, {
			hasItems: context.collections.has(operation.path),
			qualifier: context.qualifiers.get(operation.path),
		});

	if (context.taken.has(wanted)) {
		context.collisions.push({ signature, wanted, held: heldBy(context, wanted) });
	}
	// Planning carries on so one run reports every collision. The name below is
	// never written, because a collision throws before anything is emitted.
	const chosen = reserve(context.taken, wanted);
	context.holders.set(chosen, signature);

	const contentResponses = operation.successes.filter(
		(response) => response.contentType !== undefined
	);
	const emptyResponses = operation.successes.filter(
		(response) => response.contentType === undefined
	);

	return {
		spec: operation,
		name: chosen,
		queryType:
			operation.queryParameters.length > 0
				? reserve(context.taken, `${typeName(chosen)}Query`)
				: undefined,
		bodyType: bodyType(operation, chosen, context),
		resultType: resultType(operation, contentResponses, emptyResponses, chosen, context),
		contentResponses,
		emptyResponses,
		awkwardQuery: operation.queryParameters
			.filter((parameter) => serialisationOf(parameter).kind === "unsupported")
			.map((parameter) => parameter.name),
	};
}

function bodyType(
	operation: SpecOperation,
	chosen: string,
	context: OperationContext
): PlannedOperation["bodyType"] {
	const body = operation.requestBody;

	if (!body || !isJson(body.contentType)) {
		return undefined;
	}

	const component = body.componentSchema && use(body.componentSchema, context);

	return component
		? { name: component, declared: false }
		: { name: reserve(context.taken, `${typeName(chosen)}Body`), declared: true };
}

function resultType(
	operation: SpecOperation,
	contentResponses: readonly SpecResponse[],
	emptyResponses: readonly SpecResponse[],
	chosen: string,
	context: OperationContext
): PlannedOperation["resultType"] {
	// A document that declares no 2xx response at all still describes an
	// endpoint that answers something. GitHub has 8 of these, all 302.
	if (operation.successes.length === 0) {
		return { name: "unknown", declared: false };
	}
	if (contentResponses.length === 0) {
		return { name: "void", declared: false };
	}

	const components = contentResponses.map(
		(response) => response.componentSchema && use(response.componentSchema, context)
	);
	const single = components.length === 1 && emptyResponses.length === 0;

	if (single && components[0]) {
		return { name: components[0], declared: false };
	}

	return {
		name: reserve(context.taken, `${typeName(chosen)}Response`),
		declared: true,
	};
}

/** Records that this module needs a component schema, importing it when another module owns it. */
function use(component: string, context: OperationContext): string | undefined {
	const owner = context.owners.get(component);

	if (!owner) {
		return undefined;
	}
	if (owner.module !== context.name) {
		context.borrowed.set(owner.name, owner.module);
	}

	return owner.name;
}

/** How one query parameter has to reach the URL. */
export type QuerySerialisation =
	| { readonly kind: "repeat" }
	| { readonly kind: "joined"; readonly separator: string }
	| { readonly kind: "deepObject" }
	| { readonly kind: "unsupported" };

/**
 * What the document's `style` and `explode` mean for the URL.
 *
 * `buildUrl` repeats a key per array item, which covers the default and the
 * exploded delimited styles. `joined` and `deepObject` in the runtime build the
 * rest. `matrix` and `label` describe path segments rather than query strings,
 * so a document using one here asks for something this client cannot send.
 */
export function serialisationOf(parameter: SpecParameter): QuerySerialisation {
	switch (parameter.style) {
	case "form":
		return parameter.explode ? { kind: "repeat" } : { kind: "joined", separator: "," };
	case "spaceDelimited":
		return parameter.explode ? { kind: "repeat" } : { kind: "joined", separator: " " };
	case "pipeDelimited":
		return parameter.explode ? { kind: "repeat" } : { kind: "joined", separator: "|" };
	case "deepObject":
		return { kind: "deepObject" };
	default:
		return { kind: "unsupported" };
	}
}

export function isJson(contentType: string): boolean {
	const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";

	return type === "application/json" || type.endsWith("+json");
}

/**
 * Hands out a name nothing else has taken. A document with both `user` and
 * `User` would ask for `User` twice; the second gets a number, and the
 * declaration says which component it came from.
 */
function reserve(taken: Set<string>, wanted: string): string {
	let name = wanted;

	for (let suffix = 2; taken.has(name); suffix += 1) {
		name = `${wanted}${suffix}`;
	}
	taken.add(name);

	return name;
}
