import assert from "node:assert/strict";
import { test } from "node:test";

import {
	ApiClient,
	createExample,
	getExample,
	listExamples,
	type Example,
} from "../index.js";

const record: Example = {
	id: "a/b",
	name: "first",
	tags: ["x"],
	created_at: "2026-01-01T00:00:00Z",
};

test("listExamples maps the query to the API's wire names", () => {
	const operation = listExamples({ page: 2, perPage: 50, tags: ["x", "y"] });

	assert.equal(operation.method, "GET");
	assert.equal(operation.path, "/examples");
	assert.deepEqual(operation.query, { page: 2, per_page: 50, tag: ["x", "y"] });
});

test("listExamples with no filters sends no query parameters", async () => {
	let sent: Request | undefined;
	const client = new ApiClient({
		baseUrl: "https://api.test",
		transport: async (request) => {
			sent = request;
			return new Response(
				JSON.stringify({ data: [record], meta: { page: 1, per_page: 25, total: 1 } })
			);
		},
	});

	const page = await client.request(listExamples());

	assert.equal(sent?.url, "https://api.test/examples");
	assert.equal(page.meta.total, 1);
	assert.deepEqual(page.data, [record]);
});

test("getExample escapes the id and unwraps the envelope", async () => {
	let sent: Request | undefined;
	const client = new ApiClient({
		baseUrl: "https://api.test",
		transport: async (request) => {
			sent = request;
			return new Response(JSON.stringify({ data: record }));
		},
	});

	const example = await client.request(getExample("a/b"));

	assert.equal(sent?.url, "https://api.test/examples/a%2Fb");
	assert.deepEqual(example, record);
});

test("createExample sends a JSON body and unwraps the envelope", async () => {
	let sent: Request | undefined;
	const client = new ApiClient({
		baseUrl: "https://api.test",
		transport: async (request) => {
			sent = request;
			return new Response(JSON.stringify({ data: record }), { status: 201 });
		},
	});

	const created = await client.request(createExample({ name: "first", tags: ["x"] }));

	assert.equal(sent?.method, "POST");
	assert.equal(sent?.headers.get("content-type"), "application/json");
	assert.deepEqual(JSON.parse((await sent?.text()) ?? ""), {
		name: "first",
		tags: ["x"],
	});
	assert.deepEqual(created, record);
});
