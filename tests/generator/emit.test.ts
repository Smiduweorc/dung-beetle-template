import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { compileGenerated } from "../../tools/compile.js";
import { load } from "../../tools/generator/document.js";
import { emitModule } from "../../tools/generator/emit.js";
import { plan, PlanError } from "../../tools/generator/plan.js";
import { emitSchema } from "../../tools/generator/schema.js";

const root = dirname(dirname(import.meta.dirname));

function fixture(name: string): string {
	return join(import.meta.dirname, "fixtures", name);
}

async function emit(name: string, label = name): Promise<Map<string, string>> {
	const { model, bundled } = await load(fixture(name));
	const planned = plan(model);
	const files = new Map<string, string>([["schema.ts", await emitSchema(bundled, label)]]);

	for (const module of planned.modules) {
		files.set(`${module.name}.ts`, emitModule(module, model, { spec: label }));
	}

	return files;
}

/**
 * Reads a checked-in file for comparison against fresh output.
 *
 * Line endings are normalised because they belong to the checkout rather than
 * to the content: `.gitattributes` keeps the repository on LF, and this stays
 * correct in a clone made before that file existed. The generator itself only
 * ever writes `\n`.
 */
async function checkedIn(...path: readonly string[]): Promise<string> {
	return (await readFile(join(root, ...path), "utf8")).replaceAll("\r\n", "\n");
}

test("the checked-in modules are what the generator writes today", async () => {
	// The template ships generated output, so `tsc` and `eslint` check it on
	// every run. That only means something while it matches the document.
	const written = await emit("users.yaml", "./tests/generator/fixtures/users.yaml");

	assert.equal(await checkedIn("src", "resources", "users.ts"), written.get("users.ts"));
	assert.equal(await checkedIn("src", "schema.ts"), written.get("schema.ts"));
});

test("a document the runtime cannot fully express still emits code that compiles", async () => {
	const compiled = await compileGenerated(await emit("widgets.yaml"));

	assert.equal(compiled.errors, "");
	assert.ok(compiled.ok);
});

test("a body the client cannot serialise is taken as it will be sent", async () => {
	const widgets = (await emit("widgets.yaml")).get("widgets.ts") ?? "";

	assert.match(widgets, /export function createWidget\(\s*body: RequestBody/u);
	assert.match(widgets, /"content-type": "application\/x-www-form-urlencoded"/u);
	assert.match(widgets, /\n\t\tbody,\n/u);
});

test("a PATCH takes a patch, and an action keeps the API's own verb", async () => {
	const widgets = (await emit("widgets.yaml")).get("widgets.ts") ?? "";

	assert.match(widgets, /export function updateWidget\(\s*widgetId: [^,]+,\s*patch: UpdateWidgetBody/u);
	assert.match(widgets, /export function activateWidget\(\s*widgetId: [^)]+\): Operation<void>/u);
});

test("an endpoint with no 2xx response says so rather than inventing one", async () => {
	const widgets = (await emit("widgets.yaml")).get("widgets.ts") ?? "";

	assert.match(widgets, /Operation<unknown>/u);
	assert.match(widgets, /The document declares no 2xx response/u);
});

test("two path parameters in one segment are both interpolated", async () => {
	const widgets = (await emit("widgets.yaml")).get("widgets.ts") ?? "";

	assert.match(
		widgets,
		/\/widgets\/\$\{encodeURIComponent\(String\(widgetId\)\)\}\/archive\/\$\{encodeURIComponent\(String\(archiveId\)\)\}\.\$\{encodeURIComponent\(String\(format\)\)\}/u
	);
});

test("a component two modules return is declared once and imported by the other", async () => {
	const written = await emit("widgets.yaml");

	assert.match(written.get("gadgets.ts") ?? "", /^export type Widget = components/mu);
	assert.match(written.get("widgets.ts") ?? "", /import type \{ Widget \} from "\.\/gadgets\.js";/u);
});

test("a deepObject parameter keeps its declared shape and is spread into the query", async () => {
	// Stripe types `created` as a number or an object of comparisons, and reads
	// the object form as `created[gte]=`.
	const widgets = (await emit("widgets.yaml")).get("widgets.ts") ?? "";

	assert.match(widgets, /import \{ deepObject \} from "\.\.\/query\.js";/u);
	assert.match(widgets, /readonly created\?: ListWidgetsWireQuery\["created"\];/u);
	assert.match(widgets, /\.\.\.deepObject\("created", query\.created\),/u);
});

test("a required query parameter takes no default", async () => {
	const widgets = (await emit("widgets.yaml")).get("widgets.ts") ?? "";

	assert.match(widgets, /export function listWidgets\(query: ListWidgetsQuery\)/u);
});

test("two endpoints wanting one name are refused, naming the config key to fix it", async () => {
	const { model } = await load(fixture("colliding.yaml"));

	assert.throws(
		() => plan(model),
		(error: unknown) => {
			assert.ok(error instanceof PlanError);
			assert.match(error.message, /"PATCH \/things\/\{thing_id\}"/u);
			return true;
		}
	);
});

test("a name from the config replaces the one the path gives", async () => {
	const { model } = await load(fixture("colliding.yaml"));
	const planned = plan(model, { names: { "POST /things/{thing_id}": "replaceThing" } });

	assert.deepEqual(
		planned.modules.flatMap((module) => module.operations.map((operation) => operation.name)),
		["replaceThing", "updateThing"]
	);
});
