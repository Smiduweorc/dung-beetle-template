import assert from "node:assert/strict";
import { test } from "node:test";

import { DecodeError, HttpError, TransportError, type Transport } from "../index.js";
// From the runtime module rather than the `/openrpc` entry point, which only
// exists while the configuration names OpenRPC. The built entry point has its
// own test, written by the generator.
import { positional, RpcClient, RpcError, type RpcCall } from "../src/rpc.js";

interface Recorder {
	readonly transport: Transport;
	readonly requests: Request[];
}

function recording(respond: (request: Request, body: { id: unknown }) => Response | Promise<Response>): Recorder {
	const requests: Request[] = [];
	return {
		requests,
		transport: async (request) => {
			requests.push(request);
			return await respond(request, (await request.clone().json()) as { id: unknown });
		},
	};
}

/** Answers every call with `result`, echoing its id the way a server does. */
function answering(result: unknown): Recorder {
	return recording((_request, { id }) => Response.json({ jsonrpc: "2.0", id, result }));
}

function client(transport: Transport, headers?: Record<string, string>): RpcClient {
	return new RpcClient({ url: "https://rpc.example.com/v1", transport, headers });
}

const balance: RpcCall<number> = { method: "eth_getBalance", params: ["0xabc", "latest"] };

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	return await promise.then(
		() => assert.fail("expected a rejection"),
		(error: unknown) => error
	);
}

test("a call is posted to the url as a JSON-RPC 2.0 request", async () => {
	const stub = answering(5);

	assert.equal(await client(stub.transport).request(balance), 5);

	const [request] = stub.requests;
	assert.ok(request);
	assert.equal(request.method, "POST");
	assert.equal(request.url, "https://rpc.example.com/v1");
	assert.equal(request.headers.get("content-type"), "application/json");
	assert.deepEqual(await request.json(), {
		jsonrpc: "2.0",
		id: 1,
		method: "eth_getBalance",
		params: ["0xabc", "latest"],
	});
});

test("a call without params sends no params member", async () => {
	const stub = answering(null);

	await client(stub.transport).request({ method: "ping" });

	assert.deepEqual(await stub.requests[0]?.json(), { jsonrpc: "2.0", id: 1, method: "ping" });
});

test("named params are sent as an object", async () => {
	const stub = answering(null);

	await client(stub.transport).request({ method: "transfer", params: { to: "b", amount: 1 } });

	assert.deepEqual(((await stub.requests[0]?.json()) as { params: unknown }).params, { to: "b", amount: 1 });
});

test("request ids count up from 1 on each client", async () => {
	const stub = answering(0);
	const first = client(stub.transport);

	await first.request(balance);
	await first.request(balance);
	await client(stub.transport).request(balance);

	const ids = await Promise.all(stub.requests.map(async (request) => ((await request.json()) as { id: unknown }).id));
	assert.deepEqual(ids, [1, 2, 1]);
});

test("a result of null is a result, not a missing one", async () => {
	assert.equal(await client(answering(null).transport).request(balance), null);
});

test("call headers override client headers, and content-type is always JSON", async () => {
	const stub = answering(0);
	const rpc = client(stub.transport, { authorization: "client", "x-keep": "1", "content-type": "text/plain" });

	await rpc.request(balance, { headers: { authorization: "call", "content-type": "text/plain" } });

	const headers = stub.requests[0]?.headers;
	assert.equal(headers?.get("authorization"), "call");
	assert.equal(headers?.get("x-keep"), "1");
	assert.equal(headers?.get("content-type"), "application/json");
});

test("the signal reaches the request", async () => {
	const stub = answering(0);
	const controller = new AbortController();

	await client(stub.transport).request(balance, { signal: controller.signal });
	controller.abort();

	assert.equal(stub.requests[0]?.signal.aborted, true);
});

test("a transport rejection is a TransportError carrying the original", async () => {
	const cause = new Error("ECONNRESET");
	const error = await rejection(client(async () => Promise.reject(cause)).request(balance));

	assert.ok(error instanceof TransportError);
	assert.equal(error.method, "POST");
	assert.equal(error.url, "https://rpc.example.com/v1");
	assert.equal(error.cause, cause);
});

test("a non-2xx status is an HttpError with the body", async () => {
	const error = await rejection(
		client(async () => new Response("down", { status: 503, statusText: "Service Unavailable" })).request(balance)
	);

	assert.ok(error instanceof HttpError);
	assert.equal(error.status, 503);
	assert.equal(error.body, "down");
});

test("a JSON-RPC error object is an RpcError with its code and data", async () => {
	const stub = recording((_request, { id }) =>
		Response.json({ jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid params", data: { at: 1 } } })
	);
	const error = await rejection(client(stub.transport).request(balance));

	assert.ok(error instanceof RpcError);
	assert.equal(error.code, -32602);
	assert.deepEqual(error.data, { at: 1 });
	assert.equal(error.method, "eth_getBalance");
	assert.equal(error.url, "https://rpc.example.com/v1");
	assert.equal(
		error.message,
		"eth_getBalance at https://rpc.example.com/v1 failed with JSON-RPC error -32602: Invalid params"
	);
});

test("an error object without data leaves data undefined", async () => {
	const stub = recording((_request, { id }) =>
		Response.json({ jsonrpc: "2.0", id, error: { code: 1, message: "no" } })
	);
	const error = await rejection(client(stub.transport).request(balance));

	assert.ok(error instanceof RpcError);
	assert.equal(error.data, undefined);
});

const malformed: readonly [string, (id: unknown) => string][] = [
	["a body that is not JSON", () => "<html>"],
	["an array body", () => "[]"],
	["a null body", () => "null"],
	["a body without jsonrpc 2.0", (id) => JSON.stringify({ jsonrpc: "1.0", id, result: 1 })],
	["a response to another id", () => JSON.stringify({ jsonrpc: "2.0", id: 99, result: 1 })],
	["a body with neither result nor error", (id) => JSON.stringify({ jsonrpc: "2.0", id })],
	["an error that is not an object", (id) => JSON.stringify({ jsonrpc: "2.0", id, error: "no" })],
	["an error without a numeric code", (id) => JSON.stringify({ jsonrpc: "2.0", id, error: { code: "1", message: "x" } })],
	["an error without a string message", (id) => JSON.stringify({ jsonrpc: "2.0", id, error: { code: 1 } })],
];

for (const [name, body] of malformed) {
	test(`${name} is a DecodeError, not a result`, async () => {
		const stub = recording((_request, { id }) => new Response(body(id)));
		const error = await rejection(client(stub.transport).request(balance));

		assert.ok(error instanceof DecodeError);
		assert.equal(error.status, 200);
		assert.ok(error.body !== undefined);
	});
}

test("the global fetch is looked up at call time, not at construction", async () => {
	const original = globalThis.fetch;
	const rpc = new RpcClient({ url: "https://rpc.example.com" });

	globalThis.fetch = async () => Response.json({ jsonrpc: "2.0", id: 1, result: "late" });
	try {
		assert.equal(await rpc.request(balance), "late");
	} finally {
		globalThis.fetch = original;
	}
});

test("a url that is not absolute is refused at construction", () => {
	assert.throws(() => new RpcClient({ url: "/relative" }), TypeError);
});

test("positional params drop omitted ones from the end", () => {
	assert.deepEqual(positional(["a", undefined, undefined]), ["a"]);
	assert.deepEqual(positional(["a", "b"]), ["a", "b"]);
	assert.deepEqual(positional([]), []);
	assert.deepEqual(positional([undefined]), []);
});

test("an omitted param before a given one is sent as null", () => {
	assert.deepEqual(positional(["a", undefined, "c"]), ["a", null, "c"]);
});

test("a null the caller passed stays null, even at the end", () => {
	assert.deepEqual(positional(["a", null]), ["a", null]);
});
