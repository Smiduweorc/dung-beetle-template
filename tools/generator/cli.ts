import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { ConfigError, resolveConfig } from "./config.js";
import { load, SpecError } from "./document.js";
import { BANNER_MARK, emitModule } from "./emit.js";
import { plan, PlanError } from "./plan.js";
import { emitSchema } from "./schema.js";
import {
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

Writes resource modules from the OpenAPI document named in dungbeetle.config.ts.

Options:
  --config <path>  Configuration file. Default: ./dungbeetle.config.ts
  --spec <path>    Document to read, in place of the one the configuration
                   names. A path is resolved against the working directory and
                   a URL is taken as it stands. Where there is no configuration
                   file this is enough on its own.
  --dry-run        Report what would change and write nothing.
  --help           Print this and exit.

Files under src/resources/ that do not carry the generated banner are left
alone, so hand-written resources can sit alongside generated ones.
`;

const RESOURCES = join("src", "resources");
const SCHEMA = join("src", "schema.ts");
const INDEX = "index.ts";
const SURFACE = join("tests", "dist", "public-api.test.js");

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
	// typing it is; `spec` in the file is resolved against the file, where its
	// author was. `config.spec` itself stays the text that was given, because
	// it is what the generated banners cite.
	const base = override === undefined ? root : process.cwd();
	const spec = /^[a-z][a-z0-9+.-]*:/iu.test(config.spec)
		? config.spec
		: resolve(base, config.spec);

	const { model, bundled } = await load(spec, { headers: config.specHeaders });
	const planned = plan(model, { names: config.names });
	const written = dryRun ? "would write" : "written";

	const files = new Map<string, string>([
		[SCHEMA, await emitSchema(bundled, config.spec)],
		...planned.modules.map(
			(module): [string, string] => [
				join(RESOURCES, `${module.name}.ts`),
				emitModule(module, model, {
					spec: config.spec,
					runtimeImport: config.runtimeImport,
					schemaImport: config.schemaImport,
				}),
			]
		),
	]);

	await mkdir(join(root, RESOURCES), { recursive: true });

	for (const [file, content] of files) {
		const path = join(root, file);
		const existing = await read(path);

		if (existing !== undefined && !existing.includes(BANNER_MARK)) {
			throw new PlanError(
				`${file} exists and was not written by this generator. Move it aside or rename the resource with the \`names\` map before generating again.`
			);
		}
		if (existing === content) {
			report(`${posix(file)} unchanged`);
			continue;
		}
		if (!dryRun) {
			await writeFile(path, content, "utf8");
		}
		report(`${posix(file)} ${written}`);
	}

	await removeStale(root, files, dryRun);
	await updateRegions(root, planned, dryRun, written);
}

/** Deletes modules an earlier run wrote and this one no longer produces. */
async function removeStale(
	root: string,
	files: ReadonlyMap<string, string>,
	dryRun: boolean
): Promise<void> {
	const present = await readdir(join(root, RESOURCES));

	for (const entry of present.sort()) {
		const file = join(RESOURCES, entry);

		if (!entry.endsWith(".ts") || files.has(file)) {
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
			`${posix(file)} ${dryRun ? "would be removed" : "removed"}, the document no longer describes it`
		);
	}
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
