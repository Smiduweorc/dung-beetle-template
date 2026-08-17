import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { ConfigError, loadConfig } from "./config.js";
import { load, SpecError } from "./document.js";
import { BANNER_MARK, emitModule } from "./emit.js";
import { plan, PlanError } from "./plan.js";
import { emitSchema } from "./schema.js";
import { securityNotes } from "./security.js";
import {
	exportsRegion,
	generatedValues,
	hasRegion,
	namesIn,
	posix,
	surfaceModule,
	withRegion,
} from "./surface.js";

// The command a person runs. Diagnostics go to stderr, nothing goes to stdout,
// and the exit code is the part a script reads: 0 wrote or would write, 1 the
// document or the configuration was refused, 2 the command line was wrong.

const HELP = `Usage: npm run generate -- [options]

Writes resource modules from the OpenAPI document named in dungbeetle.config.ts.

Options:
  --config <path>  Configuration file. Default: ./dungbeetle.config.ts
  --dry-run        Report what would change and write nothing.
  --help           Print this and exit.

Files under src/resources/ that do not carry the generated banner are left
alone, so hand-written resources can sit alongside generated ones.
`;

const RESOURCES = join("src", "resources");
const SCHEMA = join("src", "schema.ts");
const INDEX = "index.ts";
const SURFACE = join("tests", "dist", "generated-surface.js");
const README = "README.md";

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

	try {
		await generate(resolve(options.config), options["dry-run"]);
		return 0;
	} catch (error) {
		if (error instanceof SpecError || error instanceof PlanError || error instanceof ConfigError) {
			report(error.message);
			return 1;
		}
		throw error;
	}
}

async function generate(configPath: string, dryRun: boolean): Promise<void> {
	const config = await loadConfig(configPath);
	const root = dirname(configPath);
	const spec = /^[a-z][a-z0-9+.-]*:/iu.test(config.spec)
		? config.spec
		: resolve(root, config.spec);

	const { model, bundled } = await load(spec, { headers: config.specHeaders });
	const planned = plan(model, { names: config.names });
	const written = dryRun ? "would write" : "written";

	const files = new Map<string, string>([
		[SCHEMA, await emitSchema(bundled, config.spec)],
		[SURFACE, surfaceModule(planned, config.spec)],
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

	// Read before the loop below overwrites it, so the run can report what the
	// package's public surface gained and lost.
	const before = namesIn((await read(join(root, SURFACE))) ?? "");

	await mkdir(join(root, RESOURCES), { recursive: true });

	for (const [file, content] of files) {
		const path = join(root, file);
		const existing = await read(path);

		if (existing !== undefined && !existing.includes(BANNER_MARK)) {
			throw new PlanError(
				`${file} exists and was not written by this generator. Move it aside, or rename what would overwrite it with the \`names\` map, before generating again.`
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
	await updateRegions(root, planned, model, dryRun, written);
	reportSurface(before, generatedValues(planned), planned);
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
	model: Parameters<typeof securityNotes>[0],
	dryRun: boolean,
	written: string
): Promise<void> {
	const regions: readonly [string, string, string][] = [
		[INDEX, exportsRegion(planned, posix(RESOURCES)), "generated exports"],
		[README, securityNotes(model), "generated authentication notes"],
	];

	for (const [file, content, note] of regions) {
		const path = join(root, file);
		const existing = await read(path);

		if (existing === undefined) {
			report(`${posix(file)} is missing, so its ${note} region was skipped`);
			continue;
		}
		// A README is prose someone wrote. It gets the notes where it asks for
		// them and nowhere else, unlike the two files this template owns.
		if (file === README && !hasRegion(existing)) {
			report(`${posix(file)} carries no markers, so its ${note} were skipped`);
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

}

/** What this run did to the package's public API, which is a semver question. */
function reportSurface(
	before: readonly string[],
	after: readonly string[],
	planned: ReturnType<typeof plan>
): void {
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
