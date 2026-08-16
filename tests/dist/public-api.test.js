// Consumes the build output the way an installed package is consumed, so the
// entry point, the emitted specifiers and the published surface all get
// exercised. Run with `npm run test:dist`, which builds first.

import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { test } from "node:test";

import * as pkg from "../../dist/index.js";

// Update this list by hand: a name added or removed here is a change to the
// package's public API, and semver applies to it.
const publicSurface = [
	"ApiClient",
	"ApiError",
	"DecodeError",
	"HttpError",
	"TransportError",
	"createExample",
	"deepObject",
	"getExample",
	"joined",
	"listExamples",
	"readJson",
];

// The generator rewrites the block below and prints what it added or removed,
// so a generated change to the public API is still something a person reads in
// review rather than something that lands unannounced.
// dung-beetle:start generated public surface
const generatedSurface = [
	"createUser",
	"deleteUser",
	"getUser",
	"listUserSessions",
	"listUsers",
];
// dung-beetle:end

test("the built entry point exports exactly the intended surface", () => {
	assert.deepEqual(Object.keys(pkg).sort(), [...publicSurface, ...generatedSurface].sort());
});

test("type declarations are emitted where package.json points", async () => {
	await access(new URL("../../dist/types/index.d.ts", import.meta.url));
});

test("a request works through the built artifact", async () => {
	const client = new pkg.ApiClient({
		baseUrl: "https://api.test/v1",
		transport: async () => new Response(JSON.stringify({ data: [], meta: {} })),
	});

	assert.deepEqual(await client.request(pkg.listExamples()), { data: [], meta: {} });
});

test("errors thrown by the built artifact are catchable by type", async () => {
	const client = new pkg.ApiClient({
		baseUrl: "https://api.test/v1",
		transport: async () => new Response("nope", { status: 500 }),
	});

	const error = await client.request(pkg.listExamples()).then(
		() => undefined,
		(caught) => caught
	);

	assert.ok(error instanceof pkg.HttpError);
	assert.ok(error instanceof pkg.ApiError);
	assert.equal(error.status, 500);
});
