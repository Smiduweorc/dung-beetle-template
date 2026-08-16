import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compileGenerated } from "./compile.js";
import { load } from "./generator/document.js";
import { emitModule } from "./generator/emit.js";
import { plan, PlanError, type Collision } from "./generator/plan.js";
import { emitSchema } from "./generator/schema.js";

// Runs the whole generator over the largest documents anyone publishes, which
// are too big to keep in the repository (Stripe is 6.4MB, GitHub 12.9MB), so
// this fetches them. `npm test` covers the two small ones that are checked in.
//
// Both failures worth having so far came from documents like these rather than
// from the fixtures: rejecting Stripe outright over 618 schema nits, and
// emitting Stripe query filters that would not compile.

interface Document {
	readonly name: string;
	readonly url: string;
}

const CORPUS: readonly Document[] = [
	{
		name: "stripe",
		url: "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.yaml",
	},
	{
		name: "github",
		url: "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json",
	},
];

function say(line: string): void {
	process.stdout.write(`${line}\n`);
}

/**
 * Names for the endpoints that collide, so the run can go on and check
 * everything else. A person would put real names in the config; the point here
 * is how many there are, not what they are called.
 */
function placeholders(collisions: readonly Collision[]): Record<string, string> {
	return Object.fromEntries(
		collisions.map((collision, index) => [collision.signature, `${collision.wanted}${index + 2}`])
	);
}

async function check(document: Document): Promise<boolean> {
	const started = Date.now();
	const directory = await mkdtemp(join(tmpdir(), "dung-beetle-corpus-"));

	try {
		const response = await fetch(document.url);
		if (!response.ok) {
			say(`${document.name}: ${document.url} answered HTTP ${response.status}`);
			return false;
		}

		const path = join(directory, document.url.endsWith(".json") ? "spec.json" : "spec.yaml");
		await writeFile(path, await response.text(), "utf8");

		const { model, bundled } = await load(path);
		let names: Record<string, string> = {};
		let planned;

		try {
			planned = plan(model);
		} catch (error) {
			if (!(error instanceof PlanError)) {
				throw error;
			}
			names = placeholders(error.collisions);
			planned = plan(model, { names });
		}

		const files = new Map([["schema.ts", await emitSchema(bundled, document.name)]]);
		for (const module of planned.modules) {
			files.set(`${module.name}.ts`, emitModule(module, model, { spec: document.name }));
		}

		const compiled = await compileGenerated(files);
		const endpoints = planned.modules.flatMap((module) => module.operations).length;
		const seconds = ((Date.now() - started) / 1000).toFixed(1);

		say(
			`${document.name}: ${endpoints} endpoints, ${planned.modules.length} modules, ` +
				`${Object.keys(names).length} names to settle, ${seconds}s`
		);
		if (!compiled.ok) {
			say(compiled.errors.split("\n").slice(0, 20).join("\n"));
		}

		return compiled.ok;
	} catch (error) {
		say(`${document.name}: ${error instanceof Error ? error.message : String(error)}`);
		return false;
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

const results = [];
for (const document of CORPUS) {
	results.push(await check(document));
}

process.exitCode = results.every(Boolean) ? 0 : 1;
