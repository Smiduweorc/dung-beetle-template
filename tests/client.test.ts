import assert from "node:assert/strict";
import { test } from "node:test";

import {
	ApiClient,
	DecodeError,
	HttpError,
	TransportError,
	type Operation,
	type Transport,
} from "../index.js";

interface Recorder {
	readonly transport: Transport;
	readonly requests: Request[];
}

function recording(respond: (request: Request) => Response | Promise<Response>): Recorder {
	const requests: Request[] = [];
	return {
		requests,
		transport: async (request) => {
			requests.push(request);
			return await respond(request);
		},
	};
}

function json(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), init);
}

const ping: Operation<{ ok: boolean }> = { method: "GET", path: "/ping" };

test("joins the operation path onto the base path instead of replacing it", async () => {
	const stub = recording(() => json({ ok: true }));
	const client = new ApiClient({
		baseUrl: "https://api.test/v1",
		transport: stub.transport,
	});

	await client.request(ping);

	assert.equal(stub.requests[0]?.url, "https://api.test/v1/ping");
});

test("a trailing base slash and a missing leading path slash both work", async () => {
	const stub = recording(() => json({ ok: true }));
	const client = new ApiClient({
		baseUrl: "https://api.test/v1/",
		transport: stub.transport,
	});

	await client.request({ method: "GET", path: "ping" } satisfies Operation<unknown>);

	assert.equal(stub.requests[0]?.url, "https://api.test/v1/ping");
});

test("serialises query values, repeats arrays and drops null and undefined", async () => {
	const stub = recording(() => json({ ok: true }));
	const client = new ApiClient({
		baseUrl: "https://api.test",
		transport: stub.transport,
	});

	await client.request({
		method: "GET",
		path: "/search",
		query: {
			q: "a b",
			page: 2,
			exact: false,
			tag: ["x", "y"],
			empty: "",
			missing: undefined,
			cleared: null,
		},
	} satisfies Operation<unknown>);

	const url = new URL(stub.requests[0]?.url ?? "");
	assert.equal(url.searchParams.get("q"), "a b");
	assert.equal(url.searchParams.get("page"), "2");
	assert.equal(url.searchParams.get("exact"), "false");
	assert.deepEqual(url.searchParams.getAll("tag"), ["x", "y"]);
	assert.equal(url.searchParams.get("empty"), "");
	assert.equal(url.searchParams.has("missing"), false);
	assert.equal(url.searchParams.has("cleared"), false);
});

test("query parameters on the base URL survive", async () => {
	const stub = recording(() => json({ ok: true }));
	const client = new ApiClient({
		baseUrl: "https://api.test/v1?key=abc",
		transport: stub.transport,
	});

	await client.request(ping);

	const url = new URL(stub.requests[0]?.url ?? "");
	assert.equal(url.searchParams.get("key"), "abc");
});

test("headers layer client, then operation, then call", async () => {
	const stub = recording(() => json({ ok: true }));
	const client = new ApiClient({
		baseUrl: "https://api.test",
		transport: stub.transport,
		headers: { "x-client": "client", "x-operation": "client", "x-call": "client" },
	});

	await client.request(
		{
			method: "GET",
			path: "/ping",
			headers: { "x-operation": "operation", "x-call": "operation" },
		} satisfies Operation<unknown>,
		{ headers: { "x-call": "call" } }
	);

	const headers = stub.requests[0]?.headers;
	assert.equal(headers?.get("x-client"), "client");
	assert.equal(headers?.get("x-operation"), "operation");
	assert.equal(headers?.get("x-call"), "call");
});

test("sends the method and body the operation declared", async () => {
	const stub = recording(() => json({ ok: true }));
	const client = new ApiClient({
		baseUrl: "https://api.test",
		transport: stub.transport,
	});

	await client.request({
		method: "POST",
		path: "/things",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name: "thing" }),
	} satisfies Operation<unknown>);

	const request = stub.requests[0];
	assert.equal(request?.method, "POST");
	assert.equal(request?.headers.get("content-type"), "application/json");
	assert.equal(await request?.text(), "{\"name\":\"thing\"}");
});

test("passes the abort signal through to the transport", async () => {
	const stub = recording(() => json({ ok: true }));
	const client = new ApiClient({
		baseUrl: "https://api.test",
		transport: stub.transport,
	});

	await client.request(ping, { signal: AbortSignal.abort() });

	assert.equal(stub.requests[0]?.signal.aborted, true);
});

test("decodes JSON into the operation's result type by default", async () => {
	const client = new ApiClient({
		baseUrl: "https://api.test",
		transport: async () => json({ ok: true }),
	});

	assert.deepEqual(await client.request(ping), { ok: true });
});

test("uses a custom decode when the operation supplies one", async () => {
	const client = new ApiClient({
		baseUrl: "https://api.test",
		transport: async () => json({ data: { id: "1" } }),
	});

	const unwrapped: Operation<{ id: string }> = {
		method: "GET",
		path: "/things/1",
		decode: async (response) =>
			((await response.json()) as { data: { id: string } }).data,
	};

	assert.deepEqual(await client.request(unwrapped), { id: "1" });
});

test("a non-2xx status becomes an HttpError carrying the body", async () => {
	const client = new ApiClient({
		baseUrl: "https://api.test",
		transport: async () =>
			new Response("{\"message\":\"nope\"}", {
				status: 422,
				statusText: "Unprocessable Content",
				headers: { "content-type": "application/json" },
			}),
	});

	const error = await client.request(ping).then(
		() => undefined,
		(caught: unknown) => caught
	);

	assert.ok(error instanceof HttpError);
	assert.equal(error.status, 422);
	assert.equal(error.statusText, "Unprocessable Content");
	assert.equal(error.method, "GET");
	assert.equal(error.url, "https://api.test/ping");
	assert.equal(error.body, "{\"message\":\"nope\"}");
	assert.equal(error.headers.get("content-type"), "application/json");
});

test("a failing status is not retried", async () => {
	const stub = recording(() => new Response("", { status: 503 }));
	const client = new ApiClient({
		baseUrl: "https://api.test",
		transport: stub.transport,
	});

	await client.request(ping).catch(() => undefined);

	assert.equal(stub.requests.length, 1);
});

test("a rejecting transport becomes a TransportError keeping the cause", async () => {
	const cause = new Error("ECONNREFUSED");
	const client = new ApiClient({
		baseUrl: "https://api.test",
		transport: async () => {
			throw cause;
		},
	});

	const error = await client.request(ping).then(
		() => undefined,
		(caught: unknown) => caught
	);

	assert.ok(error instanceof TransportError);
	assert.equal(error.cause, cause);
	assert.equal(error.method, "GET");
	assert.equal(error.url, "https://api.test/ping");
});

test("a body that is not JSON becomes a DecodeError carrying the body", async () => {
	const client = new ApiClient({
		baseUrl: "https://api.test",
		transport: async () => new Response("<html>gateway</html>"),
	});

	const error = await client.request(ping).then(
		() => undefined,
		(caught: unknown) => caught
	);

	assert.ok(error instanceof DecodeError);
	assert.equal(error.status, 200);
	assert.equal(error.body, "<html>gateway</html>");
});

test("a custom decode that throws is wrapped in a DecodeError", async () => {
	const client = new ApiClient({
		baseUrl: "https://api.test",
		transport: async () => json({ ok: true }),
	});

	const error = await client
		.request({
			method: "GET",
			path: "/ping",
			decode: () => Promise.reject(new Error("missing field")),
		} satisfies Operation<unknown>)
		.then(
			() => undefined,
			(caught: unknown) => caught
		);

	assert.ok(error instanceof DecodeError);
	assert.equal((error.cause as Error).message, "missing field");
});

test("the global fetch is used lazily, never at construction", async (t) => {
	const original = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = async (): Promise<Response> => {
		calls += 1;
		return json({ ok: true });
	};
	t.after(() => {
		globalThis.fetch = original;
	});

	const client = new ApiClient({ baseUrl: "https://api.test" });
	assert.equal(calls, 0);

	await client.request(ping);
	assert.equal(calls, 1);
});
