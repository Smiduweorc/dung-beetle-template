import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { load } from "../../tools/generator/document.js";
import type { NormalizedDocument, SpecSecurityScheme } from "../../tools/generator/model.js";
import { securityNotes } from "../../tools/generator/security.js";

function document(
	schemes: readonly SpecSecurityScheme[],
	security: NormalizedDocument["security"] = []
): NormalizedDocument {
	return {
		title: "Test API",
		version: "1.0",
		servers: [],
		security,
		securitySchemes: schemes,
		operations: [],
	};
}

test("a document with no schemes says so instead of printing an empty table", () => {
	assert.equal(securityNotes(document([])), "Test API declares no security schemes.");
});

test("each scheme names the place and the exact name only the document knows", () => {
	const notes = securityNotes(
		document([
			{ kind: "apiKey", name: "Header", in: "header", parameterName: "X-API-Key" },
			{ kind: "http", name: "Basic", scheme: "basic" },
			{ kind: "http", name: "Token", scheme: "bearer", bearerFormat: "JWT" },
			{ kind: "mutualTLS", name: "Certificate" },
		])
	);

	assert.match(notes, /\| `Header` \| `apiKey` in header \| Header `X-API-Key` \|/u);
	assert.match(notes, /\| `Basic` \|.*\| Header `authorization: Basic <base64 of user:password>` \|/u);
	assert.match(notes, /\| `Token` \| `http`, bearer \(JWT\) \| Header `authorization: Bearer <token>` \|/u);
	assert.match(notes, /Client certificates are configured on whatever `fetch`-shaped function/u);
});

test("an API key in the query says what it needs, since no client header can carry it", () => {
	const notes = securityNotes(
		document([{ kind: "apiKey", name: "Key", in: "query", parameterName: "api_key" }])
	);

	assert.match(notes, /Query parameter `api_key`/u);
	assert.match(notes, /`ApiClient` sends no query of its own, so a transport decorator/u);
});

test("an API key in a cookie warns that a browser will not set it", () => {
	const notes = securityNotes(
		document([{ kind: "apiKey", name: "Key", in: "cookie", parameterName: "sid" }])
	);

	assert.match(notes, /A browser will not let `fetch` set a cookie/u);
});

test("oauth2 gives the URLs and scopes, and points at the decorator that ships", () => {
	const notes = securityNotes(
		document([
			{
				kind: "oauth2",
				name: "OAuth",
				flows: [
					{
						kind: "clientCredentials",
						tokenUrl: "https://auth.test/token",
						scopes: { "users:read": "Read users.", "users:write": "Write users." },
					},
				],
			},
		])
	);

	assert.match(notes, /Client credentials flow: take a token from https:\/\/auth\.test\/token\./u);
	assert.match(notes, /Scopes: `users:read` and `users:write`\./u);
	assert.match(notes, /`withBearerToken` from the `\/transport` subpath/u);
});

test("what applies by default reads as the choice the document describes", () => {
	const schemes: readonly SpecSecurityScheme[] = [
		{ kind: "apiKey", name: "Key", in: "header", parameterName: "X-Key" },
		{ kind: "http", name: "Token", scheme: "bearer" },
	];

	assert.match(
		securityNotes(document(schemes, [{ Key: [] }, { Token: [] }])),
		/Every endpoint requires `Key` or `Token` unless it says otherwise\./u
	);
	assert.match(
		securityNotes(document(schemes, [{ Key: [], Token: [] }])),
		/Every endpoint requires `Key` and `Token` unless it says otherwise\./u
	);
	assert.match(
		securityNotes(document(schemes)),
		/The document requires nothing by default/u
	);
});

test("the notes for the fixture document match what its README carries", async () => {
	// The template's own README opted in, so this keeps the two in step the way
	// the generated modules are kept in step.
	const { model } = await load(
		join(import.meta.dirname, "fixtures", "users.yaml")
	);

	assert.match(securityNotes(model), /Every endpoint requires `ApiKey`/u);
	assert.match(securityNotes(model), /Query parameter `api_key`/u);
});
