import assert from "node:assert/strict";
import { test } from "node:test";

import type { HttpMethod } from "../../src/operation.js";
import type { SpecOperation } from "../../tools/generator/model.js";
import { functionName, moduleName } from "../../tools/generator/names.js";

function endpoint(signature: string): SpecOperation {
	const [method, path] = signature.split(" ");

	return {
		method: method as HttpMethod,
		path: path ?? "/",
		deprecated: false,
		tags: [],
		pathParameters: [],
		queryParameters: [],
		headerParameters: [],
		cookieParameters: [],
		successes: [],
	};
}

test("the convention table maps methods and paths to function names", () => {
	const named = [
		"GET /users",
		"GET /users/{id}",
		"POST /users",
		"PUT /users/{id}",
		"PATCH /users/{id}",
		"DELETE /users/{id}",
		"GET /users/{id}/sessions",
		"POST /users/{id}/activate",
	].map((signature) => `${signature} -> ${functionName(endpoint(signature))}`);

	assert.deepEqual(named, [
		"GET /users -> listUsers",
		"GET /users/{id} -> getUser",
		"POST /users -> createUser",
		"PUT /users/{id} -> replaceUser",
		"PATCH /users/{id} -> updateUser",
		"DELETE /users/{id} -> deleteUser",
		"GET /users/{id}/sessions -> listUserSessions",
		"POST /users/{id}/activate -> activateUser",
	]);
});

test("a nested item folds its parent in and keeps both singular", () => {
	assert.equal(
		functionName(endpoint("GET /users/{user_id}/sessions/{session_id}")),
		"getUserSession"
	);
	assert.equal(
		functionName(endpoint("DELETE /users/{user_id}/sessions/{session_id}")),
		"deleteUserSession"
	);
	assert.equal(
		functionName(endpoint("POST /users/{user_id}/sessions/{session_id}/revoke")),
		"revokeUserSession"
	);
});

test("a version prefix names nothing and is dropped", () => {
	assert.equal(functionName(endpoint("GET /v1/payment_intents")), "listPaymentIntents");
	assert.equal(moduleName(endpoint("GET /v1/payment_intents")), "payment-intents");
	assert.equal(moduleName(endpoint("GET /api-keys/{id}")), "api-keys");
});

test("POST on one item reads as an update, which is what such APIs mean", () => {
	assert.equal(functionName(endpoint("POST /v1/customers/{customer}")), "updateCustomer");
});

test("a singleton sub-resource is read as one thing rather than a collection", () => {
	assert.equal(functionName(endpoint("GET /users/{id}/profile")), "getUserProfile");
	assert.equal(functionName(endpoint("PUT /users/{id}/profile")), "replaceUserProfile");
	assert.equal(functionName(endpoint("DELETE /users/{id}/profile")), "deleteUserProfile");
});

test("a path that names nothing still gets a name", () => {
	assert.equal(functionName(endpoint("GET /")), "getRoot");
	assert.equal(moduleName(endpoint("GET /")), "root");
});

test("a segment that cannot open an identifier is prefixed", () => {
	assert.equal(functionName(endpoint("POST /users/{id}/2fa")), "_2faUser");
});

test("a path the document has items under is a collection, whatever its noun reads as", () => {
	assert.equal(functionName(endpoint("GET /codes_of_conduct")), "getCodesOfConduct");
	assert.equal(
		functionName(endpoint("GET /codes_of_conduct"), { hasItems: true }),
		"listCodesOfConduct"
	);
});

test("a collection keeps the API's own word instead of an invented plural", () => {
	assert.equal(
		functionName(endpoint("GET /balance/history"), { hasItems: true }),
		"listBalanceHistory"
	);
});

test("a parameter that only qualifies an item joins the name", () => {
	assert.equal(
		functionName(endpoint("GET /gists/{gist_id}/{sha}"), { qualifier: "sha" }),
		"getGistBySha"
	);
	assert.equal(
		functionName(endpoint("GET /apps/{app_slug}"), { qualifier: "app_slug" }),
		"getAppBySlug"
	);
	assert.equal(
		functionName(endpoint("GET /accounts/{account}"), { qualifier: "account" }),
		"getAccountById"
	);
});

test("a singular collection is one thing, so it is read with get", () => {
	assert.equal(functionName(endpoint("GET /v1/account")), "getAccount");
	assert.equal(functionName(endpoint("GET /2fa")), "get2fa");
});
