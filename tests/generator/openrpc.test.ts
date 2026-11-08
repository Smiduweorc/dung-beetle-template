import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { compileGenerated } from "../../tools/compile.js";
import { SpecError } from "../../tools/generator/document.js";
import {
	emitRpcModule,
	emitRpcSchema,
	emitRpcTypes,
	loadRpc,
	planRpc,
	rpcExports,
	rpcModuleName,
	type RpcDocument,
} from "../../tools/generator/openrpc.js";
import { PlanError } from "../../tools/generator/plan.js";

const root = dirname(dirname(import.meta.dirname));
const ledger = join(import.meta.dirname, "fixtures", "ledger.openrpc.json");
const label = "./tests/generator/fixtures/ledger.openrpc.json";

/** The smallest document that loads, with `methods` swapped for the ones given. */
function documentWith(methods: unknown, components: unknown = {}): Record<string, unknown> {
	return { openrpc: "1.3.2", info: { title: "T", version: "1" }, methods, components };
}

async function loadJson(value: unknown, raw?: string): Promise<RpcDocument> {
	const directory = await mkdtemp(join(tmpdir(), "dung-beetle-openrpc-"));
	const path = join(directory, "openrpc.json");
	try {
		await writeFile(path, raw ?? JSON.stringify(value), "utf8");
		return await loadRpc(path);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

async function refusal(value: unknown, raw?: string): Promise<string> {
	const error = await loadJson(value, raw).then(
		() => assert.fail("expected the document to be refused"),
		(caught: unknown) => caught
	);
	assert.ok(error instanceof SpecError);
	return error.message;
}

async function emitAll(document: RpcDocument, spec = label): Promise<Map<string, string>> {
	const plan = planRpc(document);
	const files = new Map<string, string>([["rpc-schema.ts", await emitRpcSchema(document, spec)]]);
	if (plan.schemas.length > 0) {
		files.set("methods/types.ts", emitRpcTypes(plan, spec));
	}
	for (const module of plan.modules) {
		files.set(`methods/${module.name}.ts`, emitRpcModule(module, spec));
	}
	return files;
}

async function checkedIn(...path: readonly string[]): Promise<string> {
	return (await readFile(join(root, ...path), "utf8")).replaceAll("\r\n", "\n");
}

const method = { name: "m", params: [], result: { name: "r", schema: {} } };

test("the checked-in OpenRPC modules are what the generator writes today", async () => {
	const files = await emitAll(await loadRpc(ledger));

	assert.deepEqual([...files.keys()].sort(), [
		"methods/ledger.ts",
		"methods/methods.ts",
		"methods/types.ts",
		"rpc-schema.ts",
	]);
	for (const [name, source] of files) {
		assert.equal(await checkedIn("src", ...name.split("/")), source, name);
	}
});

test("the generated OpenRPC modules compile against the real runtime", async () => {
	const files = await emitAll(await loadRpc(ledger));
	const compiled = await compileGenerated(files);

	assert.equal(compiled.errors, "");
	assert.ok(compiled.ok);
});

test("the generated call is the one the document describes, typed end to end", async () => {
	const compiled = await compileGenerated(
		new Map([
			...(await emitAll(await loadRpc(ledger))),
			[
				"methods/check.ts",
				[
					"import { ledgerTransfer, ledgerListTransfers } from \"./ledger.js\";",
					"import type { RpcCall } from \"../rpc.js\";",
					"import type { Transfer } from \"./types.js\";",
					"export const named: RpcCall<Transfer> = ledgerTransfer({ fromAccount: \"a\", toAccount: \"b\", amount: { currency: \"EUR\", minor_units: 1 } });",
					"// @ts-expect-error A required param left out does not compile.",
					"ledgerTransfer({ fromAccount: \"a\", toAccount: \"b\" });",
					"// @ts-expect-error A param of the wrong type does not compile.",
					"ledgerListTransfers({ accountId: \"a\", limit: \"ten\" });",
					"",
				].join("\n"),
			],
		])
	);

	assert.equal(compiled.errors, "");
});

test("a method is grouped by the namespace before its first _ or .", () => {
	assert.equal(rpcModuleName("eth_getBalance"), "eth");
	assert.equal(rpcModuleName("rpc.discover"), "rpc");
	assert.equal(rpcModuleName("Admin_peers"), "admin");
	assert.equal(rpcModuleName("ping"), "methods");
	assert.equal(rpcModuleName("_private"), "methods");
	assert.equal(rpcModuleName("trailing_"), "methods");
});

test("by-position params are sent through positional, in document order", async () => {
	const source = (await emitAll(await loadRpc(ledger))).get("methods/ledger.ts") ?? "";

	assert.match(source, /params: positional\(\[params\.accountId, params\.limit, params\.before\]\),/u);
});

test("by-name params keep the wire names the document declares", async () => {
	const source = (await emitAll(await loadRpc(ledger))).get("methods/ledger.ts") ?? "";

	assert.match(source, /\t\t\tfrom_account: params\.fromAccount,\n\t\t\tto_account: params\.toAccount,/u);
});

test("a by-name param that is not an identifier is quoted", async () => {
	const document = await loadJson(
		documentWith([{ ...method, paramStructure: "by-name", params: [{ name: "a-b", required: true, schema: {} }] }])
	);
	const source = (await emitAll(document)).get("methods/methods.ts") ?? "";

	assert.match(source, /\t\t\t"a-b": params\.aB,/u);
});

test("a method with only optional params can be called with none", async () => {
	const document = await loadJson(documentWith([{ ...method, params: [{ name: "x", schema: {} }] }]));
	const source = (await emitAll(document)).get("methods/methods.ts") ?? "";

	assert.match(source, /export function m\(params: MParams = \{\}\): RpcCall<MResult>/u);
});

test("a method with no params takes no argument and sends none", async () => {
	const source = (await emitAll(await loadRpc(ledger))).get("methods/methods.ts") ?? "";

	assert.match(source, /export function ping\(\): RpcCall<PingResult> \{\n\treturn \{\n\t\tmethod: "ping",\n\t\};/u);
	assert.doesNotMatch(source, /positional/u);
});

test("documented errors and deprecation reach the doc comment", async () => {
	const files = await emitAll(await loadRpc(ledger));

	assert.match(files.get("methods/ledger.ts") ?? "", /@throws \{RpcError\} 4004: No such account/u);
	assert.match(files.get("methods/ledger.ts") ?? "", /\/\*\* @deprecated \*\/\n\treadonly memo\?/u);
	assert.match(files.get("methods/methods.ts") ?? "", /\* @deprecated\n \*\/\nexport function ping/u);
});

test("a comment terminator in a description cannot end the comment", async () => {
	const document = await loadJson(documentWith([{ ...method, summary: "a */ b" }]));

	assert.match((await emitAll(document)).get("methods/methods.ts") ?? "", /a \*\\\/ b/u);
});

test("a method without a result is a notification and is left out", async () => {
	const document = await loadRpc(ledger);

	assert.deepEqual(document.notifications, ["ledger_balanceChanged"]);
	assert.ok(!document.methods.some((entry) => entry.name === "ledger_balanceChanged"));
});

test("methods are sorted by name whatever order the document lists them", async () => {
	const document = await loadJson(documentWith([{ ...method, name: "b" }, { ...method, name: "a" }]));

	assert.deepEqual(document.methods.map((entry) => entry.name), ["a", "b"]);
});

test("the exported surface lists every function and every exported type", async () => {
	const exported = rpcExports(planRpc(await loadRpc(ledger)));

	assert.deepEqual(exported.values, ["ledgerGetAccount", "ledgerListTransfers", "ledgerTransfer", "ping"]);
	assert.deepEqual(exported.types, [
		"Account",
		"Amount",
		"LedgerGetAccountParams",
		"LedgerListTransfersParams",
		"LedgerListTransfersResult",
		"LedgerTransferParams",
		"PingResult",
		"Transfer",
	]);
});

test("the names map renames a method by its wire name", async () => {
	const plan = planRpc(await loadRpc(ledger), { names: { ledger_transfer: "sendMoney" } });

	assert.ok(rpcExports(plan).values.includes("sendMoney"));
	assert.ok(rpcExports(plan).types.includes("SendMoneyParams"));
	assert.ok(!rpcExports(plan).values.includes("ledgerTransfer"));
});

test("a names key the document does not have is refused, not ignored", async () => {
	const document = await loadRpc(ledger);

	assert.throws(
		() => planRpc(document, { names: { ledger_tranfser: "x" } }),
		(error: unknown) => error instanceof PlanError && /"ledger_tranfser"/u.test(error.message)
	);
});

test("two methods that camel-case alike are a collision naming both", async () => {
	const document = await loadJson(documentWith([{ ...method, name: "get_user" }, { ...method, name: "getUser" }]));

	assert.throws(
		() => planRpc(document),
		(error: unknown) =>
			error instanceof PlanError &&
			error.collisions.length >= 1 &&
			error.collisions[0]?.signature === "get_user" &&
			error.collisions[0]?.held === "getUser"
	);
});

test("a generated type that a component schema already names is a collision", async () => {
	const document = await loadJson(
		documentWith([{ ...method, name: "thing", params: [{ name: "x", schema: {} }] }], {
			schemas: { thing_params: { type: "string" } },
		})
	);

	assert.throws(
		() => planRpc(document),
		(error: unknown) =>
			error instanceof PlanError &&
			error.collisions[0]?.wanted === "ThingParams" &&
			error.collisions[0]?.held === "components.schemas.thing_params"
	);
});

test("a document that is not JSON is refused", async () => {
	assert.match(await refusal(undefined, "openrpc: 1.3.2"), /is not JSON/u);
});

test("a file that is not there is refused with the reason", async () => {
	const error = await loadRpc(join(tmpdir(), "no-such-openrpc.json")).then(
		() => assert.fail("expected a refusal"),
		(caught: unknown) => caught
	);

	assert.ok(error instanceof SpecError);
	assert.match(error.message, /Could not read an OpenRPC document/u);
});

const refused: readonly [string, unknown, RegExp][] = [
	["a document that is not an object", [], /is not an object/u],
	["an OpenRPC version other than 1.x", { ...documentWith([]), openrpc: "2.0.0" }, /1\.x version/u],
	["a missing openrpc version", { info: { title: "T", version: "1" }, methods: [] }, /1\.x version/u],
	["an info without a title", { ...documentWith([]), info: { version: "1" } }, /`info`/u],
	["methods that are not an array", documentWith({}), /`methods` must be an array/u],
	["a method without a name", documentWith([{ params: [] }]), /must be a method with a `name`/u],
	["a method given by $ref", documentWith([{ $ref: "#/x" }]), /References to methods are not followed/u],
	["a repeated method name", documentWith([method, method]), /repeats the method name "m"/u],
	["a method without params", documentWith([{ name: "m", result: method.result }]), /`params` array/u],
	["a param without a name", documentWith([{ ...method, params: [{ schema: {} }] }]), /content descriptor with a `name`/u],
	["a param without a schema", documentWith([{ ...method, params: [{ name: "x" }] }]), /has no `schema`/u],
	[
		"two params with one name",
		documentWith([{ ...method, params: [{ name: "x", schema: {} }, { name: "x", schema: {} }] }]),
		/two params named "x"/u,
	],
	[
		"a required param after an optional one",
		documentWith([{ ...method, params: [{ name: "a", schema: {} }, { name: "b", required: true, schema: {} }] }]),
		/required param "b" after an optional one/u,
	],
	["an unknown paramStructure", documentWith([{ ...method, paramStructure: "by-magic" }]), /paramStructure/u],
	[
		"a content descriptor $ref that does not resolve",
		documentWith([{ ...method, params: [{ $ref: "#/components/contentDescriptors/Nope" }] }]),
		/#\/components\/contentDescriptors\/Nope, which this document does not declare/u,
	],
	[
		"a schema $ref that does not resolve",
		documentWith([{ ...method, result: { name: "r", schema: { $ref: "#/components/schemas/Nope" } } }]),
		/only `#\/components\/schemas\/` entries/u,
	],
	[
		"a schema $ref to another file",
		documentWith([{ ...method, result: { name: "r", schema: { $ref: "other.json#/Thing" } } }]),
		/refers to other\.json#\/Thing/u,
	],
	[
		"a $ref nested inside a component schema that does not resolve",
		documentWith([method], { schemas: { A: { type: "array", items: { $ref: "#/components/schemas/B" } } } }),
		/components\.schemas\.A\.items/u,
	],
	[
		"an error without a code",
		documentWith([{ ...method, errors: [{ message: "x" }] }]),
		/numeric `code` and a string `message`/u,
	],
	[
		"an error $ref that does not resolve",
		documentWith([{ ...method, errors: [{ $ref: "#/components/errors/Nope" }] }]),
		/#\/components\/errors\/Nope/u,
	],
];

for (const [name, document, message] of refused) {
	test(`${name} is refused`, async () => {
		assert.match(await refusal(document), message);
	});
}

test("a $ref with an escaped segment resolves to the component it names", async () => {
	const document = await loadJson(
		documentWith([{ ...method, result: { name: "r", schema: { $ref: "#/components/schemas/a~1b" } } }], {
			schemas: { "a/b": { type: "string" } },
		})
	);

	assert.equal(document.methods[0]?.result.component, "a/b");
});

test("a schema with a $ref and other keywords is typed inline, not aliased", async () => {
	const document = await loadJson(
		documentWith([{ ...method, result: { name: "r", schema: { $ref: "#/components/schemas/A", description: "x" } } }], {
			schemas: { A: { type: "string" } },
		})
	);

	assert.equal(document.methods[0]?.result.component, undefined);
});

test("required defaults to false, as the specification says", async () => {
	const document = await loadJson(documentWith([{ ...method, params: [{ name: "x", schema: {} }] }]));

	assert.equal(document.methods[0]?.params[0]?.required, false);
});

test("a document is fetched over http with the configured headers", async (context) => {
	const seen: Headers[] = [];
	context.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
		seen.push(new Headers(init.headers));
		return Response.json(documentWith([method]));
	});

	const document = await loadRpc("https://example.com/openrpc.json", {
		headers: [{ name: "authorization", value: "Bearer t" }],
	});

	assert.equal(document.methods.length, 1);
	assert.equal(seen[0]?.get("authorization"), "Bearer t");
});

test("a document that answers with a non-2xx status is refused", async (context) => {
	context.mock.method(globalThis, "fetch", async () => new Response("no", { status: 404 }));

	await assert.rejects(loadRpc("https://example.com/openrpc.json"), /HTTP 404/u);
});
