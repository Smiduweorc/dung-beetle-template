import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { ConfigError, resolveConfig, type GeneratorConfig } from "./config.js";
import { load, SpecError } from "./document.js";
import { BANNER_MARK, emitModule } from "./emit.js";
import { generateProtos } from "./grpc.js";
import {
	emitRpcModule,
	emitRpcSchema,
	emitRpcTypes,
	loadRpc,
	planRpc,
	rpcExports,
} from "./openrpc.js";
import { compare } from "./order.js";
import { plan, PlanError } from "./plan.js";
import { emitSchema } from "./schema.js";
import {
	exportList,
	exportsRegion,
	generatedValues,
	posix,
	previousValues,
	surfaceRegion,
	withRegion,
} from "./surface.js";

// The command a person runs. Diagnostics go to stderr, nothing goes to stdout,
// and the exit code is the part a script reads: 0 wrote or would write, 1 the
// document or the configuration was refused, 2 the command line was wrong.

const HELP = `Usage: npm run generate -- [options]

Writes the client for every protocol dungbeetle.config.ts configures:
OpenAPI, OpenRPC and gRPC. A protocol the configuration leaves out has its
generated files, its subpath export and its surface test removed.

Options:
  --config <path>  Configuration file. Default: ./dungbeetle.config.ts
  --spec <path>    OpenAPI document to read, in place of \`openapi.spec\`. A path is resolved against the working directory and
                   a URL is taken as it stands. Where there is no configuration
                   file this is enough on its own.
  --dry-run        Report what would change and write nothing.
  --help           Print this and exit.

Files that do not carry the generated banner are left alone, so hand-written
resources can sit alongside generated ones.
`;

const RESOURCES = join("src", "resources");
const SCHEMA = join("src", "schema.ts");
const INDEX = "index.ts";
const SURFACE = join("tests", "dist", "public-api.test.js");

const METHODS = join("src", "methods");
const RPC_SCHEMA = join("src", "rpc-schema.ts");
const RPC_ENTRY = "openrpc.ts";
const RPC_SURFACE = join("tests", "dist", "openrpc.test.js");

const PROTOS = join("src", "grpc");
const GRPC_ENTRY = "grpc.ts";
const GRPC_SURFACE = join("tests", "dist", "grpc.test.js");

/** What the generated `/grpc` code imports, which therefore has to ship with the package. */
const PROTOBUF = "@bufbuild/protobuf";

function report(line: string): void {
	process.stderr.write(`${line}\n`);
}

async function main(argv: readonly string[]): Promise<number> {
	let options;
	try {
		({ values: options } = parseArgs({
			args: [...argv],
			options: {
				config: { type: "string", default: "dungbeetle.config.ts" },
				spec: { type: "string" },
				"dry-run": { type: "boolean", default: false },
				help: { type: "boolean", default: false },
			},
			strict: true,
		}));
	} catch (cause) {
		report(cause instanceof Error ? cause.message : String(cause));
		report(HELP);
		return 2;
	}

	if (options.help) {
		process.stderr.write(HELP);
		return 0;
	}

	if (options.spec !== undefined && options.spec.length === 0) {
		report("--spec needs a path or a URL.");
		report(HELP);
		return 2;
	}

	try {
		await generate(resolve(options.config), options["dry-run"], options.spec);
		return 0;
	} catch (error) {
		if (error instanceof SpecError || error instanceof PlanError || error instanceof ConfigError) {
			report(error.message);
			return 1;
		}
		throw error;
	}
}

async function generate(
	configPath: string,
	dryRun: boolean,
	override: string | undefined
): Promise<void> {
	const { config, fromFile } = await resolveConfig(configPath, override);
	const root = dirname(configPath);

	if (!fromFile) {
		report(
			`no ${basename(configPath)}, so --spec is the whole configuration and no name overrides apply`
		);
	}

	// A `--spec` is resolved against the working directory, where the person
	// typing it is; paths in the file are resolved against the file, where its
	// author was. The configured text itself stays as it was given, because it
	// is what the generated banners cite.
	const locate = (given: string, base: string): string =>
		/^[a-z][a-z0-9+.-]*:/iu.test(given) ? given : resolve(base, given);

	const manifest = await readManifest(root, config);
	if (manifest !== undefined) {
		checkDependencies(config, manifest);
	}

	// Everything is read and planned before anything is written, so a document
	// refused halfway leaves the tree as it was.
	const files = new Map<string, string>();
	const directories: string[] = [];
	let planned: ReturnType<typeof plan> = { modules: [] };
	const notes: string[] = [];

	if (config.openapi !== undefined) {
		const { spec } = config.openapi;
		const { model, bundled } = await load(
			locate(spec, override === undefined ? root : process.cwd()),
			{ headers: config.openapi.specHeaders }
		);
		planned = plan(model, { names: config.openapi.names });
		files.set(SCHEMA, await emitSchema(bundled, spec));
		for (const module of planned.modules) {
			files.set(
				join(RESOURCES, `${module.name}.ts`),
				emitModule(module, model, {
					spec,
					runtimeImport: config.openapi.runtimeImport,
					schemaImport: config.openapi.schemaImport,
				})
			);
		}
		directories.push(RESOURCES);
	}

	if (config.openrpc !== undefined) {
		const { spec } = config.openrpc;
		const document = await loadRpc(locate(spec, root), { headers: config.openrpc.specHeaders });
		const rpcPlan = planRpc(document, { names: config.openrpc.names });
		const exported = rpcExports(rpcPlan);

		files.set(RPC_SCHEMA, await emitRpcSchema(document, spec));
		if (rpcPlan.schemas.length > 0) {
			files.set(join(METHODS, "types.ts"), emitRpcTypes(rpcPlan, spec));
		}
		for (const module of rpcPlan.modules) {
			files.set(join(METHODS, `${module.name}.ts`), emitRpcModule(module, spec));
		}
		files.set(
			RPC_ENTRY,
			rpcEntry(spec, [
				...rpcPlan.modules.map((module): Entry => ({
					from: `./${posix(METHODS)}/${module.name}.js`,
					values: rpcExports({ modules: [module], schemas: [] }).values,
					types: rpcExports({ modules: [module], schemas: [] }).types,
				})),
				...(rpcPlan.schemas.length > 0
					? [{ from: `./${posix(METHODS)}/types.js`, values: [], types: rpcPlan.schemas.map((schema) => schema.name) }]
					: []),
			])
		);
		files.set(RPC_SURFACE, rpcSurface(spec, manifest?.name ?? "", exported.values));
		directories.push(METHODS);

		for (const method of document.notifications) {
			notes.push(`${method} has no result, so it is a notification and was not generated`);
		}
	}

	if (config.grpc !== undefined) {
		const { protos } = config.grpc;
		const modules = await generateProtos(locate(protos, root), protos);

		for (const module of modules) {
			files.set(join(PROTOS, ...module.path.split("/")), module.source);
		}
		files.set(
			GRPC_ENTRY,
			grpcEntry(
				protos,
				modules.map((module): Entry => ({
					from: `./${posix(PROTOS)}/${module.path.replace(/\.ts$/u, ".js")}`,
					values: [...module.values].sort(compare),
					types: [...module.types].sort(compare),
				}))
			)
		);
		files.set(
			GRPC_SURFACE,
			grpcSurface(protos, manifest?.name ?? "", modules.flatMap((module) => module.values).sort(compare))
		);
		directories.push(PROTOS);
	}

	const written = dryRun ? "would write" : "written";

	for (const [file, content] of files) {
		const path = join(root, file);
		const existing = await read(path);

		if (existing !== undefined && !existing.includes(BANNER_MARK)) {
			throw new PlanError(
				`${posix(file)} exists and was not written by this generator. Move it aside or rename what would be written there before generating again.`
			);
		}
		if (existing === content) {
			report(`${posix(file)} unchanged`);
			continue;
		}
		if (!dryRun) {
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, content, "utf8");
		}
		report(`${posix(file)} ${written}`);
	}

	await removeStale(
		root,
		files,
		[RESOURCES, METHODS, PROTOS],
		[SCHEMA, RPC_SCHEMA, RPC_ENTRY, RPC_SURFACE, GRPC_ENTRY, GRPC_SURFACE],
		dryRun
	);
	if (manifest === undefined) {
		report("package.json is missing, so its exports were skipped");
	} else {
		await updateManifest(root, manifest, config, dryRun, written);
	}
	await updateRegions(root, planned, dryRun, written);

	for (const note of notes) {
		report(note);
	}
}

interface Manifest {
	readonly name: string;
	readonly source: string;
	readonly json: Record<string, unknown>;
}

/**
 * `package.json` next to the configuration. Only the subpath protocols need
 * one, since they are published through its `exports`; an OpenAPI-only run in
 * a bare directory goes ahead without it.
 */
async function readManifest(root: string, config: GeneratorConfig): Promise<Manifest | undefined> {
	const source = await read(join(root, "package.json"));
	if (source === undefined) {
		if (config.openrpc !== undefined || config.grpc !== undefined) {
			throw new ConfigError(
				`There is no package.json in ${root}, and the openrpc and grpc subpaths are published through its \`exports\`.`
			);
		}
		return undefined;
	}

	let json: unknown;
	try {
		json = JSON.parse(source);
	} catch (cause) {
		throw new ConfigError(`package.json in ${root} is not valid JSON.`, { cause });
	}
	if (typeof json !== "object" || json === null || typeof (json as { name?: unknown }).name !== "string") {
		throw new ConfigError(`package.json in ${root} has no \`name\`.`);
	}

	return { name: (json as { name: string }).name, source, json: json as Record<string, unknown> };
}

/**
 * The generated gRPC code imports `@bufbuild/protobuf`, so a package wrapping
 * gRPC has to depend on it, and one that does not wrap gRPC should not make
 * every consumer install it.
 */
function checkDependencies(config: GeneratorConfig, manifest: Manifest): void {
	const dependencies = manifest.json["dependencies"];
	const has =
		typeof dependencies === "object" && dependencies !== null && PROTOBUF in dependencies;

	if (config.grpc !== undefined && !has) {
		throw new ConfigError(
			`\`grpc\` is configured, and the code it generates imports ${PROTOBUF}, which package.json does not list under dependencies. Run \`npm install ${PROTOBUF}@^2\`.`
		);
	}
	if (config.grpc === undefined && has) {
		throw new ConfigError(
			`package.json depends on ${PROTOBUF}, and \`grpc\` is not configured, so every consumer would install it for nothing. Run \`npm uninstall ${PROTOBUF}\`.`
		);
	}
}

/** Adds the subpath exports of the configured protocols and removes the others'. */
async function updateManifest(
	root: string,
	manifest: Manifest,
	config: GeneratorConfig,
	dryRun: boolean,
	written: string
): Promise<void> {
	const current = manifest.json["exports"];
	const exports: Record<string, unknown> =
		typeof current === "object" && current !== null ? { ...(current as Record<string, unknown>) } : {};

	const subpaths: readonly [string, string, boolean][] = [
		["./openrpc", "openrpc", config.openrpc !== undefined],
		["./grpc", "grpc", config.grpc !== undefined],
	];
	for (const [key, entry, wanted] of subpaths) {
		if (wanted) {
			exports[key] = { types: `./dist/types/${entry}.d.ts`, default: `./dist/${entry}.js` };
		} else {
			delete exports[key];
		}
	}

	const updated = `${JSON.stringify({ ...manifest.json, exports }, null, "\t")}\n`;
	if (updated === manifest.source) {
		report("package.json unchanged");
		return;
	}
	if (!dryRun) {
		await writeFile(join(root, "package.json"), updated, "utf8");
	}
	report(`package.json ${written}`);
}

interface Entry {
	readonly from: string;
	readonly values: readonly string[];
	readonly types: readonly string[];
}

function exportBlocks(entries: readonly Entry[]): string {
	return entries
		.flatMap((entry) => [
			entry.values.length > 0 ? exportList("export", entry.values, `"${entry.from}"`) : undefined,
			entry.types.length > 0 ? exportList("export type", entry.types, `"${entry.from}"`) : undefined,
		])
		.filter((block) => block !== undefined)
		.join("\n\n");
}

function rpcEntry(spec: string, entries: readonly Entry[]): string {
	return [
		`// ${BANNER_MARK} from ${spec}. Do not edit.`,
		"//",
		"// The `/openrpc` subpath. The errors are the same classes the root exports,",
		"// so `instanceof` works whichever entry point a consumer imported them from.",
		"",
		"export { RpcClient, RpcError } from \"./src/rpc.js\";",
		"export type { RpcCall, RpcClientOptions, RpcRequestOptions } from \"./src/rpc.js\";",
		"export type { Transport } from \"./src/client.js\";",
		"export { ApiError, DecodeError, HttpError, TransportError } from \"./src/errors.js\";",
		"",
		exportBlocks(entries),
		"",
	].join("\n");
}

function grpcEntry(protos: string, entries: readonly Entry[]): string {
	return [
		`// ${BANNER_MARK} from ${protos}. Do not edit.`,
		"//",
		"// The `/grpc` subpath: message types and service descriptors for Connect-ES.",
		"// A consumer passes a service to `createClient` from `@connectrpc/connect`",
		"// along with the transport that fits their runtime.",
		"",
		exportBlocks(entries),
		"",
	].join("\n");
}

const RUNTIME_SURFACE = ["ApiError", "DecodeError", "HttpError", "RpcClient", "RpcError", "TransportError"];

function rpcSurface(spec: string, name: string, values: readonly string[]): string {
	const surface = [...RUNTIME_SURFACE, ...values].sort(compare);

	return [
		`// ${BANNER_MARK} from ${spec}. Do not edit.`,
		"//",
		"// Imports the `/openrpc` subpath through the package's own name, so the",
		"// exports map in package.json is what gets tested, not a path into dist/.",
		"",
		"import assert from \"node:assert/strict\";",
		"import { test } from \"node:test\";",
		"",
		`import * as rpc from "${name}/openrpc";`,
		"",
		"const surface = [",
		...surface.map((value) => `\t${JSON.stringify(value)},`),
		"];",
		"",
		"test(\"the built openrpc entry point exports exactly the generated surface\", () => {",
		"\tassert.deepEqual(Object.keys(rpc).sort(), surface);",
		"});",
		"",
		"test(\"a call works through the built openrpc entry point\", async () => {",
		"\tconst client = new rpc.RpcClient({",
		"\t\turl: \"https://rpc.example.com\",",
		"\t\ttransport: async (request) => {",
		"\t\t\tconst { id } = await request.json();",
		"\t\t\treturn Response.json({ jsonrpc: \"2.0\", id, result: 1 });",
		"\t\t},",
		"\t});",
		"",
		"\tassert.equal(await client.request({ method: \"anything\" }), 1);",
		"});",
		"",
		"test(\"errors from the openrpc entry point are the root's classes\", async () => {",
		"\tconst root = await import(\"../../dist/index.js\");",
		"",
		"\tassert.equal(rpc.HttpError, root.HttpError);",
		"\tassert.ok(new rpc.RpcError({ method: \"m\", url: \"u\", code: 1, message: \"x\" }) instanceof root.ApiError);",
		"});",
		"",
	].join("\n");
}

function grpcSurface(protos: string, name: string, values: readonly string[]): string {
	return [
		`// ${BANNER_MARK} from ${protos}. Do not edit.`,
		"//",
		"// Imports the `/grpc` subpath through the package's own name, so the",
		"// exports map in package.json is what gets tested, not a path into dist/.",
		"",
		"import assert from \"node:assert/strict\";",
		"import { test } from \"node:test\";",
		"",
		`import * as grpc from "${name}/grpc";`,
		"",
		"const surface = [",
		...values.map((value) => `\t${JSON.stringify(value)},`),
		"];",
		"",
		"test(\"the built grpc entry point exports exactly the generated surface\", () => {",
		"\tassert.deepEqual(Object.keys(grpc).sort(), surface);",
		"});",
		"",
	].join("\n");
}

/**
 * Deletes generated files an earlier run wrote and this one no longer
 * produces: modules the document stopped describing, and everything belonging
 * to a protocol the configuration no longer names.
 */
async function removeStale(
	root: string,
	files: ReadonlyMap<string, string>,
	directories: readonly string[],
	singles: readonly string[],
	dryRun: boolean
): Promise<void> {
	const candidates = [
		...singles,
		...(await Promise.all(directories.map((directory) => walk(root, directory)))).flat(),
	];

	for (const file of candidates.sort(compare)) {
		if (files.has(file) || !/\.(ts|js)$/u.test(file)) {
			continue;
		}

		const existing = await read(join(root, file));
		if (existing?.includes(BANNER_MARK) !== true) {
			continue;
		}
		if (!dryRun) {
			await rm(join(root, file));
		}
		report(
			`${posix(file)} ${dryRun ? "would be removed" : "removed"}, the configuration no longer produces it`
		);
	}
}

/** Every file under `directory`, relative to `root`, or none if it does not exist. */
async function walk(root: string, directory: string): Promise<string[]> {
	let entries;
	try {
		entries = await readdir(join(root, directory), { withFileTypes: true });
	} catch {
		return [];
	}

	const nested = await Promise.all(
		entries.map((entry) =>
			entry.isDirectory()
				? walk(root, join(directory, entry.name))
				: Promise.resolve([join(directory, entry.name)])
		)
	);

	return nested.flat();
}

async function updateRegions(
	root: string,
	planned: ReturnType<typeof plan>,
	dryRun: boolean,
	written: string
): Promise<void> {
	const surfacePath = join(root, SURFACE);
	const before = previousValues((await read(surfacePath)) ?? "");
	const after = generatedValues(planned);

	const regions: readonly [string, string, string][] = [
		[INDEX, exportsRegion(planned, posix(RESOURCES)), "generated exports"],
		[SURFACE, surfaceRegion(planned), "generated public surface"],
	];

	for (const [file, content, note] of regions) {
		const path = join(root, file);
		const existing = await read(path);

		if (existing === undefined) {
			report(`${posix(file)} is missing, so its ${note} region was skipped`);
			continue;
		}

		const updated = withRegion(existing, content, note);
		if (updated === existing) {
			report(`${posix(file)} unchanged`);
			continue;
		}
		if (!dryRun) {
			await writeFile(path, updated, "utf8");
		}
		report(`${posix(file)} ${written}`);
	}

	const added = after.filter((name) => !before.includes(name));
	const removed = before.filter((name) => !after.includes(name));

	report(`public names added: ${added.length > 0 ? added.join(", ") : "none"}`);
	report(`public names removed: ${removed.length > 0 ? removed.join(", ") : "none"}`);

	const awkward = planned.modules
		.flatMap((module) => module.operations)
		.flatMap((operation) => operation.awkwardQuery);

	if (awkward.length > 0) {
		report(
			`${awkward.length} query parameters are serialised in a way this client does not build; each generated function names its own.`
		);
	}
}

async function read(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}

process.exitCode = await main(process.argv.slice(2));
