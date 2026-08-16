import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, join } from "node:path";
import { test } from "node:test";

import { load, SpecError, SpecProblemsError } from "../../tools/generator/document.js";
import type { SpecOperation } from "../../tools/generator/model.js";

function fixture(name: string): string {
	return join(import.meta.dirname, "fixtures", name);
}

const { model: users } = await load(fixture("users.yaml"));

function operation(signature: string): SpecOperation {
	const found = users.operations.find(
		(candidate) => `${candidate.method} ${candidate.path}` === signature
	);

	assert.ok(found, `${signature} is not in the fixture`);
	return found;
}

test("the API's own title, version and prose survive", () => {
	assert.equal(users.title, "Users API");
	assert.equal(users.version, "2026-08-01");
	assert.equal(operation("GET /users").summary, "List users.");
	assert.equal(operation("GET /users").operationId, "read_users_users__get");
});

test("server variables take their defaults and embedded credentials are dropped", () => {
	assert.deepEqual(users.servers, [
		{ url: "https://acme.api.example.com/v1", description: "Production." },
		{
			url: "https://staging.api.example.com/v1",
			description: "Staging, with credentials the generator must not repeat.",
		},
	]);
});

test("operations are ordered by path, then by method", () => {
	assert.deepEqual(
		users.operations.map((candidate) => `${candidate.method} ${candidate.path}`),
		[
			"GET /users",
			"POST /users",
			"GET /users/{user_id}",
			"DELETE /users/{user_id}",
			"GET /users/{user_id}/sessions",
		]
	);
});

test("a path item's parameters come first, and the operation's own replace them", () => {
	const list = operation("GET /users");

	assert.deepEqual(
		list.queryParameters.map((parameter) => parameter.name),
		["page", "per_page", "tag"]
	);
	assert.equal(list.queryParameters[0]?.deprecated, true);
});

test("a header parameter OpenAPI ignores is left out, and the rest are kept", () => {
	assert.deepEqual(
		operation("GET /users").headerParameters.map((parameter) => parameter.name),
		["x-request-id"]
	);
});

test("a query array the document does not explode is reported as written", () => {
	const query = operation("GET /users").queryParameters;

	assert.deepEqual(query.find((parameter) => parameter.name === "tag"), {
		name: "tag",
		required: false,
		deprecated: false,
		description: undefined,
		componentSchema: undefined,
		style: "form",
		explode: false,
	});
	assert.equal(query.find((parameter) => parameter.name === "per_page")?.explode, true);
});

test("path parameters follow the template and are required whatever the document says", () => {
	const sessions = operation("GET /users/{user_id}/sessions");

	assert.deepEqual(
		sessions.pathParameters.map((parameter) => [parameter.name, parameter.required]),
		[["user_id", true]]
	);
	assert.deepEqual(
		sessions.cookieParameters.map((parameter) => parameter.name),
		["session_hint"]
	);
});

test("a JSON body wins over the other media types, and an external schema keeps its bundled name", () => {
	assert.deepEqual(operation("POST /users").requestBody, {
		required: true,
		contentType: "application/json",
		description: undefined,
		componentSchema: "new-user",
	});
});

test("only 2xx responses are kept, with wildcards after the numbered ones", () => {
	assert.deepEqual(
		operation("POST /users").successes.map((response) => response.status),
		["201", "202"]
	);
	assert.deepEqual(
		operation("GET /users/{user_id}/sessions").successes.map((response) => response.status),
		["200", "2XX"]
	);
	assert.deepEqual(
		operation("DELETE /users/{user_id}").successes.map((response) => response.status),
		["204"]
	);
});

test("a response with no content reports none, and a referenced response is followed", () => {
	assert.deepEqual(operation("DELETE /users/{user_id}").successes, [
		{
			status: "204",
			description: "Deleted.",
			contentType: undefined,
			componentSchema: undefined,
		},
	]);
	assert.deepEqual(operation("GET /users/{user_id}").successes, [
		{
			status: "200",
			description: "One user.",
			contentType: "application/json",
			componentSchema: "User",
		},
	]);
});

test("a response schema that is not a component reports no name to alias", () => {
	assert.deepEqual(operation("GET /users").successes, [
		{
			status: "200",
			description: "One page of users.",
			contentType: "application/json",
			componentSchema: undefined,
		},
	]);
});

test("an operation that opts out of security stays apart from one that inherits it", () => {
	assert.deepEqual(users.security, [{ ApiKey: [] }]);
	assert.deepEqual(operation("DELETE /users/{user_id}").security, []);
	assert.equal(operation("GET /users").security, undefined);
	assert.equal(operation("DELETE /users/{user_id}").deprecated, true);
});

test("security schemes are read per kind and sorted by name", () => {
	assert.deepEqual(users.securitySchemes, [
		{
			name: "ApiKey",
			description: "Sent as a query parameter, which no client header can carry.",
			kind: "apiKey",
			in: "query",
			parameterName: "api_key",
		},
		{
			name: "Bearer",
			description: undefined,
			kind: "http",
			scheme: "bearer",
			bearerFormat: "JWT",
		},
		{
			name: "OAuth",
			description: undefined,
			kind: "oauth2",
			flows: [
				{
					kind: "authorizationCode",
					authorizationUrl: "https://auth.example.com/authorize",
					tokenUrl: "https://auth.example.com/token",
					refreshUrl: "https://auth.example.com/refresh",
					scopes: { "users:read": "Read users." },
				},
			],
		},
	]);
});

test("a document served over http is read, and so are its relative references", async () => {
	const server = createServer((request, response) => {
		readFile(fixture(basename(request.url ?? "")), "utf8").then(
			(body) => {
				response.writeHead(200, { "content-type": "text/yaml" });
				response.end(body);
			},
			() => {
				response.writeHead(404);
				response.end();
			}
		);
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

	try {
		const address = server.address();
		assert.ok(address !== null && typeof address === "object");

		const { model: remote } = await load(`http://127.0.0.1:${address.port}/users.yaml`);
		const created = remote.operations.find(
			(candidate) => candidate.method === "POST" && candidate.path === "/users"
		);

		assert.equal(remote.title, "Users API");
		assert.equal(created?.requestBody?.componentSchema, "new-user");
	} finally {
		server.close();
	}
});

test("a document behind a credential is read with the headers the config gives", async () => {
	const server = createServer((request, response) => {
		if (request.headers["x-api-key"] !== "shibboleth") {
			response.writeHead(401);
			response.end();
			return;
		}
		readFile(fixture(basename(request.url ?? "")), "utf8").then(
			(body) => {
				response.writeHead(200, { "content-type": "text/yaml" });
				response.end(body);
			},
			() => {
				response.writeHead(404);
				response.end();
			}
		);
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

	try {
		const address = server.address();
		assert.ok(address !== null && typeof address === "object");
		const url = `http://127.0.0.1:${address.port}/users.yaml`;

		await assert.rejects(load(url), (error: unknown) => {
			assert.ok(error instanceof SpecError);
			assert.match(error.message, /401/u);
			return true;
		});

		const { model } = await load(url, {
			headers: [{ name: "x-api-key", value: "shibboleth" }],
		});
		assert.equal(model.title, "Users API");
	} finally {
		server.close();
	}
});

test("a structural complaint about a schema does not stop the read", async () => {
	// Stripe's document raises 618 of these, `nullable` with no `type`, and
	// generates fine. Schemas belong to openapi-typescript, not to this model.
	const { model: loose } = await load(fixture("schema-nits.yaml"));

	assert.deepEqual(
		loose.operations.map((candidate) => `${candidate.method} ${candidate.path}`),
		["GET /things"]
	);
});

test("a reference that does not resolve is fatal even inside a schema", async () => {
	await assert.rejects(load(fixture("missing-schema-ref.yaml")), (error: unknown) => {
		assert.ok(error instanceof SpecProblemsError);
		assert.deepEqual(
			error.problems.map((problem) => problem.ruleId),
			["bundler"]
		);
		return true;
	});
});

test("every problem in a document is reported in one run", async () => {
	await assert.rejects(load(fixture("broken.yaml")), (error: unknown) => {
		assert.ok(error instanceof SpecProblemsError);
		assert.deepEqual(
			error.problems.map((problem) => problem.ruleId).sort(),
			["bundler", "struct"]
		);
		assert.match(error.message, /responses/u);
		return true;
	});
});

test("a Swagger 2.0 document is refused by the version it declares", async () => {
	await assert.rejects(load(fixture("swagger.json")), (error: unknown) => {
		assert.ok(error instanceof SpecError);
		assert.match(error.message, /oas2/u);
		return true;
	});
});

test("a TRACE endpoint is refused, since the runtime's HttpMethod has none", async () => {
	await assert.rejects(load(fixture("trace.yaml")), (error: unknown) => {
		assert.ok(error instanceof SpecError);
		assert.match(error.message, /TRACE \/echo/u);
		return true;
	});
});

test("a path parameter the document never declares is refused", async () => {
	await assert.rejects(load(fixture("undeclared-path-parameter.yaml")), (error: unknown) => {
		assert.ok(error instanceof SpecError);
		assert.match(error.message, /takes a path parameter \{user_id\}/u);
		return true;
	});
});

test("a document that cannot be read names the path it was given", async () => {
	const missing = fixture("nothing-here.yaml");

	await assert.rejects(load(missing), (error: unknown) => {
		assert.ok(error instanceof SpecError);
		assert.equal(error.spec, missing);
		assert.match(error.message, /ENOENT/u);
		return true;
	});
});
