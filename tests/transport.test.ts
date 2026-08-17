// Kept byte-identical with the copy in the other template (Aphid-template and
// dung-beetle-template ship the same runtime). Change one, change both.
import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiClient, TransportError } from "../index.js";
import { withBearerToken, withRetry } from "../src/transport/index.js";

/** A transport that records what it was handed and answers with an empty object. */
function recorder(): { sent: Request[]; transport: (request: Request) => Promise<Response> } {
	const sent: Request[] = [];

	return {
		sent,
		transport: async (request) => {
			sent.push(request);
			return new Response("{}");
		},
	};
}

test("every request carries the token the source returned", async () => {
	const { sent, transport } = recorder();
	const send = withBearerToken(transport, () => "abc");

	await send(new Request("https://api.test/one"));
	await send(new Request("https://api.test/two"));

	assert.deepEqual(
		sent.map((request) => request.headers.get("authorization")),
		["Bearer abc", "Bearer abc"]
	);
});

test("an authorization header already on the request is replaced", async () => {
	const { sent, transport } = recorder();
	const send = withBearerToken(transport, () => "fresh");

	await send(
		new Request("https://api.test/one", { headers: { authorization: "Bearer stale" } })
	);

	assert.equal(sent[0]?.headers.get("authorization"), "Bearer fresh");
});

test("the caller's request is left alone, headers and body both", async () => {
	const { sent, transport } = recorder();
	const send = withBearerToken(transport, () => "abc");
	const request = new Request("https://api.test/one", { method: "POST", body: "payload" });

	await send(request);

	// What went out carries the header and the body.
	assert.notEqual(sent[0], request);
	assert.equal(sent[0]?.headers.get("authorization"), "Bearer abc");
	assert.equal(await sent[0]?.text(), "payload");

	// What the caller still holds carries neither the header nor a read body,
	// so anything wrapped around this can still send it.
	assert.equal(request.headers.get("authorization"), null);
	assert.equal(await request.text(), "payload");
});

test("requests arriving together on an expired token ask for one token", async () => {
	const { transport } = recorder();
	let calls = 0;
	let release: (token: string) => void = () => undefined;
	const send = withBearerToken(transport, () => {
		calls += 1;
		return new Promise<string>((resolve) => {
			release = resolve;
		});
	});

	const inFlight = [1, 2, 3, 4, 5].map(async (n) =>
		send(new Request(`https://api.test/${n}`))
	);
	await Promise.resolve();
	release("shared");
	await Promise.all(inFlight);

	assert.equal(calls, 1);
});

test("the next request after one settles asks again, so expiry stays the caller's", async () => {
	const { transport } = recorder();
	let calls = 0;
	const send = withBearerToken(transport, () => `token-${(calls += 1)}`);

	await send(new Request("https://api.test/one"));
	await send(new Request("https://api.test/two"));

	assert.equal(calls, 2);
});

test("a token source that rejects fails the request and caches nothing", async () => {
	const { sent, transport } = recorder();
	let calls = 0;
	const send = withBearerToken(transport, () => {
		calls += 1;
		return calls === 1 ? Promise.reject(new Error("no token")) : "recovered";
	});

	await assert.rejects(send(new Request("https://api.test/one")), /no token/u);
	// `deepEqual` against a literal would narrow `sent` to `never[]` for the
	// rest of the test, so this asks the question a different way.
	assert.equal(sent.length, 0);

	await send(new Request("https://api.test/two"));
	assert.equal(sent[0]?.headers.get("authorization"), "Bearer recovered");
});

test("through a client, a failing token source arrives as a TransportError", async () => {
	const api = new ApiClient({
		baseUrl: "https://api.test/v1",
		transport: withBearerToken(fetch, () => Promise.reject(new Error("no token"))),
	});

	const error = await api
		.request({ method: "GET", path: "/items" })
		.then(() => undefined, (caught: unknown) => caught);

	assert.ok(error instanceof TransportError);
	assert.match((error.cause as Error).message, /no token/u);
});

test("through a client, the token reaches the wire", async () => {
	const { sent, transport } = recorder();
	const api = new ApiClient({
		baseUrl: "https://api.test/v1",
		transport: withBearerToken(transport, async () => "abc"),
	});

	await api.request({ method: "GET", path: "/items" });

	assert.equal(sent[0]?.url, "https://api.test/v1/items");
	assert.equal(sent[0]?.headers.get("authorization"), "Bearer abc");
});

/** Answers with the given statuses in order, and records every request it saw. */
function answering(...statuses: readonly (number | Error)[]): {
	sent: Request[];
	transport: (request: Request) => Promise<Response>;
} {
	const sent: Request[] = [];

	return {
		sent,
		transport: async (request) => {
			sent.push(request);
			const answer = statuses[sent.length - 1] ?? 200;

			if (answer instanceof Error) {
				throw answer;
			}
			return new Response("{}", { status: answer });
		},
	};
}

const fast = { baseDelay: 1, maxDelay: 10 } as const;

test("a transient status is sent again, and the attempt that worked is returned", async () => {
	const { sent, transport } = answering(503, 200);
	const send = withRetry(transport, fast);

	const response = await send(new Request("https://api.test/one"));

	assert.equal(sent.length, 2);
	assert.equal(response.status, 200);
});

test("attempts are capped, and the last answer is what the caller gets", async () => {
	const { sent, transport } = answering(503, 503, 503, 200);
	const send = withRetry(transport, { ...fast, attempts: 3 });

	const response = await send(new Request("https://api.test/one"));

	assert.equal(sent.length, 3);
	assert.equal(response.status, 503);
});

test("a status the caller did not ask about is returned at once", async () => {
	const { sent, transport } = answering(400, 200);
	const send = withRetry(transport, fast);

	const response = await send(new Request("https://api.test/one"));

	assert.equal(sent.length, 1);
	assert.equal(response.status, 400);
});

test("a POST is left alone, because sending it twice is not sending it once", async () => {
	const { sent, transport } = answering(503, 200);
	const send = withRetry(transport, fast);

	await send(new Request("https://api.test/one", { method: "POST", body: "charge" }));

	assert.equal(sent.length, 1);
});

test("an API with idempotency keys can opt its POSTs in", async () => {
	const { sent, transport } = answering(503, 200);
	const send = withRetry(transport, { ...fast, methods: ["POST"] });

	await send(new Request("https://api.test/one", { method: "POST", body: "charge" }));

	assert.equal(sent.length, 2);
});

test("every attempt carries the body, which a single request could not", async () => {
	const bodies: string[] = [];
	const send = withRetry(
		async (request) => {
			bodies.push(await request.text());
			return new Response("{}", { status: bodies.length === 1 ? 503 : 200 });
		},
		{ ...fast, methods: ["PUT"] }
	);

	await send(new Request("https://api.test/one", { method: "PUT", body: "payload" }));

	assert.deepEqual(bodies, ["payload", "payload"]);
});

test("a rejecting transport is retried, and the last failure reaches the caller", async () => {
	const { sent, transport } = answering(new Error("reset"), new Error("reset again"));
	const send = withRetry(transport, { ...fast, attempts: 2 });

	await assert.rejects(send(new Request("https://api.test/one")), /reset again/u);
	assert.equal(sent.length, 2);
});

test("a request the caller aborted is not sent again", async () => {
	const controller = new AbortController();
	const sent: Request[] = [];
	const send = withRetry(
		async () => {
			sent.push(new Request("https://api.test/one"));
			controller.abort();
			throw new DOMException("aborted", "AbortError");
		},
		fast
	);

	await assert.rejects(
		send(new Request("https://api.test/one", { signal: controller.signal })),
		/aborted/u
	);
	assert.equal(sent.length, 1);
});

test("a Retry-After longer than the caller allows ends it rather than arriving early", async () => {
	const sent: Request[] = [];
	const send = withRetry(
		async (request) => {
			sent.push(request);
			return new Response("{}", { status: 429, headers: { "retry-after": "3600" } });
		},
		fast
	);

	const response = await send(new Request("https://api.test/one"));

	assert.equal(sent.length, 1);
	assert.equal(response.status, 429);
});

test("a Retry-After the caller allows is waited out and the request repeats", async () => {
	const sent: Request[] = [];
	const send = withRetry(
		async (request) => {
			sent.push(request);
			return sent.length === 1
				? new Response("{}", { status: 429, headers: { "retry-after": "0" } })
				: new Response("{}", { status: 200 });
		},
		fast
	);

	await send(new Request("https://api.test/one"));

	assert.equal(sent.length, 2);
});

test("aborting during the wait gives up instead of finishing the backoff", async () => {
	const controller = new AbortController();
	const sent: Request[] = [];
	const send = withRetry(
		async (request) => {
			sent.push(request);
			setTimeout(() => controller.abort(), 1);
			return new Response("{}", { status: 503 });
		},
		{ baseDelay: 5_000, maxDelay: 5_000 }
	);

	await assert.rejects(
		send(new Request("https://api.test/one", { signal: controller.signal }))
	);
	assert.equal(sent.length, 1);
});

test("the two decorators compose, asking for a token on each attempt", async () => {
	const tokens: string[] = [];
	const { sent, transport } = answering(503, 200);
	let issued = 0;
	const send = withRetry(
		withBearerToken(transport, () => `token-${(issued += 1)}`),
		fast
	);

	await send(new Request("https://api.test/one"));
	for (const request of sent) {
		tokens.push(request.headers.get("authorization") ?? "");
	}

	assert.deepEqual(tokens, ["Bearer token-1", "Bearer token-2"]);
});
