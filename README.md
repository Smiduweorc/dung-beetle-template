# @smiduweorc/dung-beetle-template

![logo](./assets/logo.jpeg)

A TypeScript template for building and publishing your own typed API client.
Point it at an API's OpenAPI document, OpenRPC document or `.proto` files and
it writes the typed client, which you review, commit and publish under your own
name.

Requires Node 22 or later (CI runs 22 and 24 on Linux, macOS and Windows). The
OpenAPI and OpenRPC runtimes need only the `fetch`, `Request`, `Response`,
`Headers` and `URL` globals and import no `node:` modules. gRPC code is
[Connect-ES](https://connectrpc.com/docs/web/getting-started), and runs
wherever Connect-ES does.

## Who installs what

- You copy this template, generate the client from the API's document, review
  the diff, and publish `@acme/api-client`.
- Your users run `npm i @acme/api-client` and import `listInvoices`. They get
  the runtime and your generated functions, nothing else. OpenAPI and OpenRPC
  add no runtime dependencies; gRPC adds `@bufbuild/protobuf`.

The generator in `tools/` stays in your repository and is not published, so
there is no `npx dung-beetle`. When the API changes, run `npm run generate`
again. It prints the public names it added and removed, which tells you the
semver bump.

## Protocols

You pick the protocols in `dungbeetle.config.ts` before you build. Each key you
keep is one protocol in the package, and a key you leave out is gone entirely:
no generated files, no subpath, no dependency.

| Key | Reads | Published as | Runtime dependency |
| --- | --- | --- | --- |
| `openapi` | OpenAPI 3.0 or 3.1 | `@acme/api-client` | none |
| `openrpc` | OpenRPC 1.x (JSON-RPC 2.0 over HTTP) | `@acme/api-client/openrpc` | none |
| `grpc` | A directory of `.proto` files | `@acme/api-client/grpc` | `@bufbuild/protobuf` |

The generator adds and removes the `exports` entries in `package.json` itself.
It does not install anything. A run with `grpc` configured and
`@bufbuild/protobuf` missing from `dependencies` stops and tells you to install
it. A run with the dependency present and no `grpc` stops and tells you to
uninstall it, so your users don't install it for nothing.

The template ships with all three, pointed at its own test fixtures.

## Quick start

This generates a client for the Arch User Repository's `/rpc` endpoints, which
are public and need no credentials.

1. Copy this repository into a new one and run `npm install`. The `prepare`
   script installs git hooks, so `git init` first if you copied the directory.

2. The AUR speaks only OpenAPI, so keep only `openapi`, point it at the
   document, and run `npm uninstall @bufbuild/protobuf`:

   ```ts
   // dungbeetle.config.ts
   export default {
   	openapi: {
   		spec: "https://aur.archlinux.org/rpc/openapi.json",
   	},
   };
   ```

3. Run `npm run generate`:

   ```
   src/schema.ts written
   src/resources/rpc.ts written
   grpc.ts removed, the configuration no longer produces it
   openrpc.ts removed, the configuration no longer produces it
   src/grpc/common/v1/money_pb.ts removed, the configuration no longer produces it
   src/grpc/widgets/v1/widgets_pb.ts removed, the configuration no longer produces it
   src/methods/ledger.ts removed, the configuration no longer produces it
   src/methods/methods.ts removed, the configuration no longer produces it
   src/methods/types.ts removed, the configuration no longer produces it
   src/resources/users.ts removed, the configuration no longer produces it
   src/rpc-schema.ts removed, the configuration no longer produces it
   tests/dist/grpc.test.js removed, the configuration no longer produces it
   tests/dist/openrpc.test.js removed, the configuration no longer produces it
   package.json written
   index.ts written
   tests/dist/public-api.test.js written
   public names added: createRpcInfo, getRpcInfo, getRpcSearch, getRpcSuggest, getRpcSuggestPkgbase, listRpcInfo
   public names removed: createUser, deleteUser, getUser, listUserSessions, listUsers
   ```

   Everything removed was generated from the template's own fixtures.
   `src/resources/example.ts` is hand-written, has no banner, and stays.

4. Fix the names. Every AUR path starts with `/rpc/v5/`, so every function
   came out with `Rpc` in it. Names come from paths; the `names` map overrides
   them:

   ```ts
   // dungbeetle.config.ts
   export default {
   	openapi: {
   		spec: "https://aur.archlinux.org/rpc/openapi.json",
   		names: {
   			"GET /rpc/v5/search/{arg}": "searchPackages",
   			"GET /rpc/v5/info/{arg}": "getPackage",
   			"GET /rpc/v5/info": "listPackages",
   			"POST /rpc/v5/info": "listPackagesByPost",
   			"GET /rpc/v5/suggest/{arg}": "suggestPackageNames",
   			"GET /rpc/v5/suggest-pkgbase/{arg}": "suggestPackageBases",
   		},
   	},
   };
   ```

   Generate again:

   ```
   public names added: getPackage, listPackages, listPackagesByPost, searchPackages, suggestPackageBases, suggestPackageNames
   public names removed: createRpcInfo, getRpcInfo, getRpcSearch, getRpcSuggest, getRpcSuggestPkgbase, listRpcInfo
   ```

5. Call it. The AUR's document declares no `servers`, so you pass the base URL:

   ```ts
   import { ApiClient, getPackage, searchPackages } from "./index.js";

   const aur = new ApiClient({ baseUrl: "https://aur.archlinux.org" });

   const found = await aur.request(searchPackages("neovim-git", { by: "name" }));
   console.log(found.resultcount, found.results?.[0]?.Name);

   const yay = await aur.request(getPackage("yay"));
   console.log(yay.results?.[0]?.Version, yay.results?.[0]?.NumVotes);
   ```

   ```
   6 goneovim-git
   13.0.1-1 2646
   ```

   `by` only accepts the 14 values the AUR document lists, so `by: "naem"`
   fails to compile.

6. Set `name`, `description` and `repository` in `package.json`, delete
   `src/resources/example.ts` and its exports in `index.ts`, add your tests
   under `tests/` as `*.test.ts`, then build and publish. Only `dist/` is
   published. The tests in `tests/generator/` that compare against the
   template's checked-in fixture output fail once that output is gone; delete
   them along with the fixtures, or keep the generator's own suite and leave
   the fixtures in place.

For your own API, use a different URL or a file path in step 2. For an API
with no machine-readable description, delete `tools/` and
`dungbeetle.config.ts` and write resource modules by hand (see
[Writing a resource](#writing-a-resource)).

## Not included

The OpenAPI and OpenRPC clients build the request, send it once through the
transport, and report what came back. They do not do any of these:

- Retries and backoff
- Caching and request deduplication
- Circuit breakers and rate limiting
- Timeouts, proxies, TLS and connection pooling (per-call cancellation is
  `RequestOptions.signal`)
- Input validation
- Response validation (`readJson` casts to the declared type without checking)
- Logging and metrics
- Reading config from `process.env`
- JSON-RPC batches and notifications
- GraphQL, SOAP, WebSockets and server-sent events. Only the three protocols
  in the table above are generated.

`ApiClient` and `RpcClient` take the same `Transport`, so one wrapper serves
both. Put these behaviours in a transport wrapper, which sees every request:

```ts
const withRetry = (inner: Transport, attempts: number): Transport =>
	async (request) => {
		for (let attempt = 1; ; attempt += 1) {
			try {
				return await inner(request);
			} catch (error) {
				if (attempt >= attempts) throw error;
				await sleep(2 ** attempt * 100);
			}
		}
	};

const api = new ApiClient({
	baseUrl: "https://api.example.com/v1",
	transport: withRetry(fetch, 3),
});
```

A wrapper that retries a request with a body must clone it first: a `Request`
body can only be read once. For gRPC, the same behaviours belong in a Connect
[interceptor](https://connectrpc.com/docs/web/interceptors) on the consumer's
transport. A static API key goes in the client's `headers`; a
credential that needs refreshing goes in a transport wrapper that sets the
header per attempt.

## Errors

Every failure is an `ApiError`:

| Class | Raised when | Carries |
| --- | --- | --- |
| `TransportError` | No response arrived (connection refused, DNS, TLS, abort) | `method`, `url`, `cause` |
| `HttpError` | Non-2xx status | `method`, `url`, `status`, `statusText`, `headers`, `body` |
| `DecodeError` | A 2xx body could not be read as the declared type | `url`, `status`, `body`, `cause` |
| `RpcError` | A JSON-RPC response carried an `error` object | `method`, `url`, `code`, `data` |

An abort is a `TransportError` whose `cause` is the `AbortError`.
`HttpError.body` is the raw text, unparsed; it is `undefined` only when reading
the body failed. A malformed operation (a body on a `GET`, a bad header name)
makes the `Request` constructor throw a plain `TypeError`.

## Writing a resource

An operation is a plain object, so building one does no I/O and its tests
assert on values. Copy `src/resources/example.ts`:

```ts
import { readJson, type Operation } from "@smiduweorc/dung-beetle-template";

export function getUser(id: string): Operation<User> {
	return {
		method: "GET",
		path: `/users/${encodeURIComponent(id)}`,
		decode: async (response) => {
			const { data } = await readJson<{ data: User }>(response);
			return data;
		},
	};
}
```

`decode` is optional; use `decode: async () => undefined` for an endpoint with
no body. `readJson` raises a `DecodeError` with the raw body on malformed JSON,
which is how you spot an HTML error page. `TResult` is not checked at runtime.

Arrays go out as one repeated key (`style: form`, `explode: true`). For other
query shapes use `joined(query.tags, ",")` (gives `tag=a,b`) and
`...deepObject("created", query.created)` (gives `created[gte]=1`, as Stripe
wants). Generated code uses both where the document asks for them.

## OpenRPC

Each method becomes a function returning an `RpcCall`, which `RpcClient` posts
as a JSON-RPC 2.0 request:

```ts
import { ledgerGetAccount, RpcClient } from "@acme/api-client/openrpc";

const ledger = new RpcClient({ url: "https://rpc.example.com" });
const account = await ledger.request(ledgerGetAccount({ accountId: "acc_1" }));
```

Params are always one object keyed by camel-cased param name. A method
declaring `paramStructure: "by-name"` sends them as an object under their wire
names. Otherwise they go as an array in document order: trailing omitted params
are dropped, and an omitted param before a given one is sent as `null`.
Methods are grouped into `src/methods/<namespace>.ts` by the part of the name
before the first `_` or `.` (`eth_getBalance` goes to `eth.ts`), and a method
without a namespace goes to `methods.ts`. `ethGetBalance` is the function name;
`openrpc.names`, keyed by method name, renames it.

## gRPC

`buf generate` runs [`protoc-gen-es`](https://github.com/bufbuild/protobuf-es)
over `grpc.protos` and writes `src/grpc/**/*_pb.ts`: message types, schemas and
service descriptors. Your users bring `@connectrpc/connect` and whichever
transport fits their runtime:

```ts
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { WidgetService } from "@acme/api-client/grpc";

const widgets = createClient(WidgetService, createGrpcTransport({ baseUrl: "https://api.example.com" }));
const widget = await widgets.getWidget({ id: "w1" });
```

`@connectrpc/connect-node` speaks native gRPC over HTTP/2.
`@connectrpc/connect-web` runs in browsers and speaks the Connect protocol and
gRPC-Web, so the server, or a proxy like Envoy in front of it, has to speak one
of those too. The tests call the generated service over both gRPC and Connect,
unary and server streaming.

## The generator

The full config:

```ts
// dungbeetle.config.ts
import type { GeneratorConfig } from "./tools/generator/config.js";

const config: GeneratorConfig = {
	openapi: {
		spec: "./openapi.yaml",

		// Names the path rules read badly, and endpoints that would collide.
		names: { "GET /v1/accounts/{account}": "getAccountById" },

		// For a document behind a private URL. This file runs at build time and
		// never ships, so reading the environment here is fine.
		specHeaders: [{ name: "authorization", value: `Bearer ${process.env.SCHEMA_TOKEN}` }],

		// Set when the runtime is a package you depend on instead of `src/`.
		runtimeImport: "@acme/api-runtime",

		// Module openapi-typescript writes to, when it is not `../schema.js`.
		schemaImport: "../schema.js",
	},

	openrpc: {
		spec: "./openrpc.json",
		names: { eth_getBalance: "getBalance" },
		specHeaders: [{ name: "authorization", value: `Bearer ${process.env.SCHEMA_TOKEN}` }],
	},

	grpc: {
		// The import root: `<protos>/users/v1/users.proto` is `users/v1/users.proto`.
		protos: "./proto",
	},
};

export default config;
```

This is the whole schema. A key that isn't in it, at the top level or inside a
protocol, stops the run and names the key.

`--dry-run` reports what would change and writes nothing. `--spec <url or
path>` reads a different OpenAPI document with the rest of the config still
applied, and works without a config file.

For OpenAPI it writes `src/resources/<noun>.ts` (one per first path segment,
with a banner), `src/schema.ts` (via [`openapi-typescript`](https://openapi-ts.dev)),
and the marked regions in `index.ts` and `tests/dist/public-api.test.js`. For
OpenRPC it writes `src/methods/`, `src/rpc-schema.ts` (also through
`openapi-typescript`), `openrpc.ts` and `tests/dist/openrpc.test.js`. For gRPC
it writes `src/grpc/`, `grpc.ts` and `tests/dist/grpc.test.js`. The two
generated surface tests import through the package's own name, so they test the
`exports` map. A file without the banner is never touched.

Names come from the method and path, never `operationId` (real documents emit
`read_user_users__user_id__get` and `agents/get-repo-public-key`):
`GET /users` is `listUsers`, `GET /users/{id}` is `getUser`, `PUT` is
`replace`, `PATCH` is `update`, `POST /users/{id}/activate` is `activateUser`.
A path with items under it is a collection whatever its noun
(`listCodesOfConduct`), a trailing parameter joins the name
(`/gists/{gist_id}/{sha}` is `getGistBySha`), and a version prefix is dropped.
When two endpoints want one name, the run stops and prints every collision with
a block to paste under `names`. Stripe's 589 endpoints have 5 collisions and
GitHub's 1220 have 27.

It refuses:

- Anything other than OpenAPI 3.0 or 3.1, including Swagger 2.0, and
  anything other than OpenRPC 1.x.
- An OpenRPC `$ref` outside the document, or one that does not resolve, and a
  required param listed after an optional one.
- Two `.proto` files that export the same name, since `/grpc` is one module.
- A document with broken paths, parameters, responses or security schemes, or
  a `$ref` that does not resolve. All problems come back in one
  `SpecProblemsError`. Schema nits are left to `openapi-typescript`: Stripe's
  document raises 618 of them (`nullable` with no `type`) and generates fine.
- `trace` endpoints.
- A path parameter the document never declares.
- Overwriting a file it did not write.

It skips, and says so in the generated code:

- Webhooks, callbacks and error response schemas.
- All but one request media type per endpoint, JSON first. A non-JSON body is
  a `RequestBody` the caller builds.
- `matrix` and `label` query parameters.
- Authentication. Each function's `@security` line says which scheme applies
  and where the credential goes.
- OpenRPC methods with no `result`, which are notifications. The run lists
  each one.

`npm test` runs it against the fixtures and the two documents in
`tests/generator/corpus/`. Stripe and GitHub are too big to check in; a weekly
workflow fetches and generates them.

`npm run live` goes one step further: it generates clients for the Arch User
Repository (OpenAPI), a public Ethereum node (OpenRPC) and Connect's Eliza demo
(gRPC), type-checks a consumer's code against them, and calls all three over
the network. See [`examples/README.md`](examples/README.md). The same weekly
workflow runs it.

## Known quirks

- `openapi-typescript` declares a peer of TypeScript 5 and this project is on
  6. An `overrides` entry in `package.json` settles it; it runs correctly on 6.
- OpenRPC documents are read as JSON only, as the specification defines them.
- An OpenRPC param or result with an inline schema is typed through a key like
  `components["schemas"]["ledger_listTransfers:params:limit"]` in
  `src/rpc-schema.ts`. Hover shows the key, not the type, until you follow it.
- `src/rpc.ts` is compiled into `dist/` even without `openrpc`. Nothing in
  `exports` reaches it, so it can't be imported.
- Removing a protocol deletes its generated files but leaves the empty
  directories behind.
- TypeDoc warns about the `@generated` tags protoc-gen-es writes and the
  `@security` tags this generator writes. The docs build anyway.

Commit messages, hooks and `release.sh` work as described in
[black-garden-ants](https://github.com/Smiduweorc/black-garden-ants).
