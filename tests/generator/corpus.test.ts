import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { compileGenerated } from "../../tools/compile.js";
import { load } from "../../tools/generator/document.js";
import { emitModule } from "../../tools/generator/emit.js";
import { plan } from "../../tools/generator/plan.js";
import { emitSchema } from "../../tools/generator/schema.js";

// Documents nobody here wrote. The fixtures next door each exercise one rule,
// which means they only ever ask questions someone already thought of; these
// two ask whatever their authors happened to write. See corpus/README.md for
// where they came from, and `npm run corpus` for the two large ones.

for (const document of ["petstore.json", "museum.yaml"]) {
	test(`${document} generates code that compiles`, async () => {
		const { model, bundled } = await load(join(import.meta.dirname, "corpus", document));
		const planned = plan(model);
		const files = new Map([["schema.ts", await emitSchema(bundled, document)]]);

		for (const module of planned.modules) {
			files.set(`${module.name}.ts`, emitModule(module, model, { spec: document }));
		}

		assert.ok(planned.modules.length > 0, "the document described no endpoints");

		const compiled = await compileGenerated(files);
		assert.equal(compiled.errors, "");
		assert.ok(compiled.ok);
	});
}
