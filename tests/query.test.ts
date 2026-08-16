import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiClient, deepObject, joined } from "../index.js";

test("deepObject brackets each key of an object", () => {
	assert.deepEqual(deepObject("created", { gte: 1, lte: 2 }), {
		"created[gte]": "1",
		"created[lte]": "2",
	});
});

test("deepObject keeps nesting, and indexes arrays so objects inside them survive", () => {
	assert.deepEqual(deepObject("filter", { range: { gte: 1 } }), { "filter[range][gte]": "1" });
	assert.deepEqual(deepObject("expand", ["customer", "charge"]), {
		"expand[0]": "customer",
		"expand[1]": "charge",
	});
	assert.deepEqual(deepObject("item", [{ id: "a" }]), { "item[0][id]": "a" });
});

test("deepObject passes a plain value through, and sends nothing for an absent one", () => {
	assert.deepEqual(deepObject("created", 1_700_000_000), { created: "1700000000" });
	assert.deepEqual(deepObject("created", undefined), {});
	assert.deepEqual(deepObject("created", null), {});
});

test("joined uses the separator the style asks for", () => {
	assert.equal(joined(["a", "b"], ","), "a,b");
	assert.equal(joined(["a", "b"], " "), "a b");
	assert.equal(joined(["a", "b"], "|"), "a|b");
	assert.equal(joined("a", ","), "a");
});

test("joined sends nothing for an empty or absent value", () => {
	assert.equal(joined([], ","), undefined);
	assert.equal(joined(undefined, ","), undefined);
	assert.equal(joined(null, ","), undefined);
});

test("the bracketed keys reach the URL as the API reads them", async () => {
	let sent: Request | undefined;
	const client = new ApiClient({
		baseUrl: "https://api.test/v1",
		transport: async (request) => {
			sent = request;
			return new Response("{}");
		},
	});

	await client.request({
		method: "GET",
		path: "/charges",
		query: { limit: 10, ...deepObject("created", { gte: 1 }), tag: joined(["a", "b"], ",") },
	});

	assert.equal(sent?.url, "https://api.test/v1/charges?limit=10&created%5Bgte%5D=1&tag=a%2Cb");
});
