import assert from "node:assert/strict";
import { test } from "node:test";

import { ConfigError, validate } from "../../tools/generator/config.js";

function refusal(config: unknown): string {
	try {
		validate("dungbeetle.config.ts", config);
	} catch (error) {
		assert.ok(error instanceof ConfigError);
		return error.message;
	}
	return assert.fail("expected the configuration to be refused");
}

test("each protocol alone is a complete configuration", () => {
	for (const config of [
		{ openapi: { spec: "./openapi.yaml" } },
		{ openrpc: { spec: "./openrpc.json" } },
		{ grpc: { protos: "./protos" } },
	]) {
		assert.deepEqual(validate("c", config), config);
	}
});

test("every documented key is accepted", () => {
	const config = {
		openapi: {
			spec: "https://example.com/openapi.json",
			runtimeImport: "@acme/runtime",
			schemaImport: "../schema.js",
			specHeaders: [{ name: "authorization", value: "t", matches: "example.com/**" }],
			names: { "GET /users": "listPeople" },
		},
		openrpc: { spec: "./openrpc.json", specHeaders: [{ name: "authorization", value: "t" }], names: { eth_x: "x" } },
		grpc: { protos: "./protos" },
	};

	assert.deepEqual(validate("c", config), config);
});

const refused: readonly [string, unknown, RegExp][] = [
	["a config that is not an object", "openapi", /must export a default object/u],
	["an array", [], /must export a default object/u],
	["null", null, /must export a default object/u],
	["no protocol at all", {}, /configures no protocol/u],
	["only undefined protocols", { openapi: undefined }, /configures no protocol/u],
	["an unknown top-level key", { openapi: { spec: "x" }, graphql: {} }, /`graphql` .* is not a configuration key/u],
	["the old top-level spec", { spec: "./openapi.yaml" }, /`spec` now sits inside a protocol/u],
	["a section that is not an object", { openapi: "./openapi.yaml" }, /`openapi` .* must be an object/u],
	["an unknown key inside a section", { grpc: { protos: "x", proto: "y" } }, /`grpc\.proto` .* The keys of `grpc` are `protos`/u],
	["an OpenAPI key under openrpc", { openrpc: { spec: "x", runtimeImport: "y" } }, /`openrpc\.runtimeImport`/u],
	["a missing spec", { openapi: {} }, /`openapi\.spec` .* must be a path or a URL/u],
	["an empty spec", { openrpc: { spec: "" } }, /`openrpc\.spec`/u],
	["a spec that is not a string", { openapi: { spec: 1 } }, /`openapi\.spec`/u],
	["missing protos", { grpc: {} }, /`grpc\.protos` .* must be a directory/u],
	["names that are not an object", { openapi: { spec: "x", names: [] } }, /`openapi\.names` .* must be an object/u],
	["a name that is not an identifier", { openrpc: { spec: "x", names: { a: "not-valid" } } }, /must be a JavaScript identifier, not "not-valid"/u],
	["a name that is not a string", { openapi: { spec: "x", names: { a: 1 } } }, /must be a JavaScript identifier/u],
	["specHeaders that are not an array", { openapi: { spec: "x", specHeaders: {} } }, /`openapi\.specHeaders` .* must be an array/u],
	["a header without a value", { openapi: { spec: "x", specHeaders: [{ name: "a" }] } }, /each a string/u],
	["matches on an OpenRPC header", { openrpc: { spec: "x", specHeaders: [{ name: "a", value: "b", matches: "**" }] } }, /sets `matches`, which only OpenAPI uses/u],
];

for (const [name, config, message] of refused) {
	test(`${name} is refused`, () => {
		assert.match(refusal(config), message);
	});
}

test("a refusal names the file it came from", () => {
	assert.match(refusal({}), /^dungbeetle\.config\.ts configures no protocol/u);
});
