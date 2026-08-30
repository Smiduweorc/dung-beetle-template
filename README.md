# @smiduweorc/dung-beetle-template

![logo](./assets/logo.jpeg)

A TypeScript skeleton for building and publishing your own typed API client.
Point it at an API's OpenAPI document and it writes the client: one readable
function per endpoint, which you review, commit and publish under your own
name.

Underneath is a small runtime you also own. An endpoint is described as a
typed value, and a client turns that description into a request, sends it
through a transport you supply, and decodes the response.

> Publishing and deployment are handled manually (custom npm settings), so no
> release/publish workflow is included here.

## What it does, and who installs what

The generator in `tools/` is build-time scaffolding, the way a bundler or a
test runner is. It stays in your repository and is never published.

- **You** copy this template, run `npm run generate` against the API's
  document, review the diff, and publish `@acme/api-client`.
- **Your users** run `npm i @acme/api-client` and import `listInvoices`. They
  never install this template, and they install nothing else with yours: the
  parser and the type generator are devDependencies here that never leave your
  machine.

Installing this package itself as a dependency gives you the runtime
(`ApiClient`, `Operation`, the error types, the query builders) and nothing
that generates, so there is no `npx dung-beetle` to run.

When the API changes, re-run the generator, read the diff, and cut a version.
It prints the public names it added and removed, so a change to your package's
API is something a person sees in review rather than something that lands
unannounced.

## Quick start

A worked example against a real API: the Arch User Repository's `/rpc`
endpoints, which are public and need no credentials.

**1. Copy this repository into a new one and install.**

```sh
npm install
```

**2. Point the config at the document.**

```ts
// dungbeetle.config.ts
export default {
	spec: "https://aur.archlinux.org/rpc/openapi.json",
};
```

**3. Generate.**

```sh
npm run generate
```

```
src/schema.ts written
src/resources/rpc.ts written
src/resources/users.ts removed, the document no longer describes it
index.ts written
tests/dist/public-api.test.js written
public names added: createRpcInfo, getRpcInfo, getRpcSearch, getRpcSuggest, getRpcSuggestPkgbase, listRpcInfo
public names removed: createUser, deleteUser, getUser, listUserSessions, listUsers
```

Six endpoints in one module, `src/resources/rpc.ts`. The demo resource the
template ships was generated too, so it goes; `src/resources/example.ts` is
hand-written, carries no banner, and stays.

**4. Fix the names.** Every AUR path begins `/rpc/v5/`, so every function came
out reading `Rpc`. Names come from paths, and where a path reads badly the
`names` map is where you say so:

```ts
// dungbeetle.config.ts
export default {
	spec: "https://aur.archlinux.org/rpc/openapi.json",
	names: {
		"GET /rpc/v5/search/{arg}": "searchPackages",
		"GET /rpc/v5/info/{arg}": "getPackage",
		"GET /rpc/v5/info": "listPackages",
		"POST /rpc/v5/info": "listPackagesByPost",
		"GET /rpc/v5/suggest/{arg}": "suggestPackageNames",
		"GET /rpc/v5/suggest-pkgbase/{arg}": "suggestPackageBases",
	},
};
```

`npm run generate` again, and it reports the trade:

```
public names added: getPackage, listPackages, listPackagesByPost, searchPackages, suggestPackageBases, suggestPackageNames
public names removed: createRpcInfo, getRpcInfo, getRpcSearch, getRpcSuggest, getRpcSuggestPkgbase, listRpcInfo
```

**5. Call it.** The AUR's document declares no `servers`, so the base URL is
yours to give:

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

That transcript is from a real run. `by` is typed to the fourteen values the
document lists, so `by: "naem"` is a compile error rather than an empty result
page, and both results are typed to the schemas the AUR publishes.

**6. Make it yours.** Set `name`, `description` and `repository` in
`package.json`, delete `src/resources/example.ts` along with its exports in
`index.ts`, add tests under `tests/` as `*.test.ts`, then `npm test` and
`npm run build` before publishing.

Pointing this at your own API is step 2 with a different URL, or a path to a
file. An API that publishes no OpenAPI document works the same way by hand:
delete `tools/` and `dungbeetle.config.ts`, and follow
[Writing a wrapper](#writing-a-wrapper), which drops three devDependencies with
it.

## The boundary

**This layer describes an API and reports what happened. It does not decide
what to do about it.**

Everything below follows from that. It is worth holding to even when a
consumer asks for the convenience, because the moment a wrapper starts making
policy decisions, every consumer inherits the policy and no consumer can
replace it.

### What this layer owns

- The URL: joining paths onto a base, escaping path parameters, serialising
  query values, and translating TypeScript-side parameter names into the API's
  wire names. `deepObject` and `joined` build the query shapes a repeated key
  cannot express, such as Stripe's `created[gte]=`.
- The request: method, headers, body, and which of them belong to the client,
  the endpoint, or the call.
- The types: one named type per request and response shape the API documents.
- The failures: turning a rejection, a non-2xx status, or an unreadable body
  into an exported error class carrying what the caller needs to react.
- Sending the request exactly once, through `ApiClient`'s transport.

### What this layer never does

| Excluded | Why | Where it goes |
| --- | --- | --- |
| Retries, backoff, jitter | Whether a failed call may be repeated depends on whether the caller's operation is idempotent and how long it can wait. This package can see neither. A retry hidden in a wrapper also turns one logged call into several. | A transport decorator, or the caller's own control flow. |
| Response caching, request deduplication | Freshness requirements belong to the consumer. A cache here would be a second source of truth that no consumer can inspect, invalidate, or share with their other data. | A transport decorator, or the data layer above the wrapper. |
| Circuit breakers, rate limiting, bulkheads | These are process-wide or fleet-wide policies with state that outlives any one client. Scoping them to a wrapper instance gets the scope wrong. | A transport decorator sharing state with the rest of the process. |
| The network stack: sockets, pooling, proxies, TLS, timeouts | Choosing an agent or a deadline is a deployment decision, and pinning one here makes the package unusable in runtimes that do it differently. | The transport, which is whatever `fetch`-shaped function the consumer passes. Per-call cancellation is available through `RequestOptions.signal`. |
| Validating inputs | A wrapper that rejects arguments duplicates a check the API already performs and then disagrees with it as the API changes. The types say what the API accepts; sending it is how you find out. | The caller, or a schema layer above this one. |
| Validating responses | `readJson` asserts the response is the declared type without checking, so decoding costs nothing and the type remains a claim about the API. | A schema check in the consuming layer, when the API is not trusted. |
| Logging, metrics, progress output | A library that writes to stdout has taken something that belongs to the application. | A transport decorator, which sees every request and response. |
| Reading configuration from the environment | An import that reads `process.env` breaks in browsers and bundlers, and makes the package untestable without mutating globals. | The consumer, who passes a `baseUrl` and headers to the constructor. |
| Work at import time | Importing this package opens no connection and schedules no work, so a consumer can import it in a test harness or a cold start without paying for it. | A constructor call. |

## What your users see

The package you publish, with the functions the generator wrote from the API's
document:

```sh
npm install @acme/api-client
```

```ts
import { ApiClient, HttpError, listInvoices } from "@acme/api-client";

const api = new ApiClient({
	baseUrl: "https://api.acme.com/v1",
	headers: { authorization: `Bearer ${token}` },
});

try {
	const page = await api.request(listInvoices({ perPage: 50 }));
	console.log(page.data, page.meta.total);
} catch (error) {
	if (error instanceof HttpError && error.status === 404) {
		// error.body holds the API's own error payload
	}
	throw error;
}
```

`listInvoices` stands in for whatever your document describes. The template
ships `listExamples` in `src/resources/example.ts` as a worked equivalent to
read, and `listUsers` in `src/resources/users.ts` as a generated one.

## Writing a wrapper

### Operations and the client

An operation is a plain object. Building one touches nothing, which is what
makes the request side testable without a network:

```ts
import type { Operation } from "@smiduweorc/dung-beetle-template";

export function getUser(id: string): Operation<User> {
	return {
		method: "GET",
		path: `/users/${encodeURIComponent(id)}`,
	};
}
```

`ApiClient.request` joins `path` onto the base URL (a base of
`https://api.example.com/v1` keeps its `/v1`), appends `query`, layers the
client's headers first, then the operation's, then the call's, sends the
request, and decodes the result.

The `TResult` type parameter states what the API returns. Nothing checks the
response against it at runtime.

### Adding an endpoint

Copy `src/resources/example.ts`. Each resource module holds the types for one
part of the API and one exported function per endpoint. The functions return
operations and perform no I/O, so their tests assert on values.

For an endpoint whose response needs unwrapping, supply `decode`. Use
`readJson` in place of `response.json()`: on malformed JSON it raises a
`DecodeError` carrying the raw body, which is what tells you the API answered
with an HTML error page:

```ts
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

`decode` also covers endpoints that answer with no body:

```ts
export function deleteUser(id: string): Operation<void> {
	return {
		method: "DELETE",
		path: `/users/${encodeURIComponent(id)}`,
		decode: async () => undefined,
	};
}
```

### Query shapes a repeated key cannot express

`ApiClient` sends an array as one repeated key, which is what OpenAPI's default
(`style: form`, `explode: true`) means. Two helpers build the rest, for the
endpoints whose documents ask for them:

```ts
import { deepObject, joined } from "@smiduweorc/dung-beetle-template";

export function listCharges(query: ListChargesQuery = {}): Operation<ChargeList> {
	return {
		method: "GET",
		path: "/charges",
		query: {
			limit: query.limit,
			tag: joined(query.tags, ","),                   // tag=a,b
			...deepObject("created", query.created),        // created[gte]=1
		},
	};
}
```

`joined` covers a parameter the document does not explode, with the separator
its style names. `deepObject` spreads a filter into bracketed keys, nesting as
far as the value does and indexing arrays. Generated code uses both wherever
the document calls for them, so this is only something to reach for in a
hand-written resource.

### Errors

Every failure this package raises is an `ApiError`. Catch the base class to
catch all of them, or a subclass to react to one:

| Class | Raised when | Carries |
| --- | --- | --- |
| `TransportError` | The transport rejected, so no response arrived: connection refused, DNS failure, TLS error, abort. | `method`, `url`, `cause` |
| `HttpError` | The API answered with a non-2xx status. | `method`, `url`, `status`, `statusText`, `headers`, `body` |
| `DecodeError` | A 2xx response could not be read as the declared type. | `url`, `status`, `body`, `cause` |

An aborted request arrives as a `TransportError` whose `cause` is the
`AbortError`. `HttpError.body` is the raw text, left unparsed because an API's
error shape is its own; it is `undefined` only when reading the body failed.

One failure is not an `ApiError`: if an operation is malformed (a body on a
`GET`, an unusable header name), the `Request` constructor raises a
`TypeError`. That is a bug in the resource module, so it is left to surface as
itself.

### Where the excluded behaviour goes

`ApiClient` calls its transport exactly once per `request()`. Everything this
package excludes goes in a wrapper around that function, where it applies to
every call and stays under the consumer's control:

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

A transport that retries a request with a body must clone it first: a `Request`
body can only be read once.

Authentication is a header, so a static key or token goes in the client's
`headers`. A credential that has to be refreshed belongs in a transport
decorator, which can set the header per attempt.

## Generating from OpenAPI

The generator lives in `tools/`, stays out of the published tarball, and
imports nothing from `src/` beyond the `HttpMethod` type. A project wrapping an
API that publishes no OpenAPI document can delete the directory and lose
nothing.

[Quick start](#quick-start) runs it against a real document. The full config:

```ts
// dungbeetle.config.ts
import type { GeneratorConfig } from "./tools/generator/config.js";

const config: GeneratorConfig = {
	spec: "./openapi.yaml",

	// Names the path rules read badly, and endpoints that would collide.
	names: { "GET /v1/accounts/{account}": "getAccountById" },

	// For a document behind a private URL. Reading the environment here is
	// fine: this file runs at build time and never ships.
	specHeaders: [{ name: "authorization", value: `Bearer ${process.env.SCHEMA_TOKEN}` }],

	// Set when the runtime is a package you depend on rather than the `src/`
	// next door, which makes generated modules import from it instead.
	runtimeImport: "@acme/api-runtime",
};

export default config;
```

```sh
npm run generate                # write the modules
npm run generate -- --dry-run   # report what would change and write nothing
npm run generate -- --spec https://api.acme.com/openapi.json
```

`--spec` reads a document other than the one the configuration names, which is
how you try an API without editing a file first. A path is resolved against the
working directory and a URL is taken as it stands; the rest of the
configuration, `names` included, still applies. Where there is no
`dungbeetle.config.ts` at all the flag is enough on its own, and the run says
so, since no name overrides can apply to a document named on the command line.

It writes four things:

- `src/resources/<noun>.ts`, one module per first path segment, each carrying a
  banner. A file in that directory without the banner is never touched, so
  hand-written resources sit safely beside generated ones.
- `src/schema.ts`, every type the document declares, written by
  [`openapi-typescript`](https://openapi-ts.dev). Nobody edits it; resource
  modules alias into it, so `components["schemas"]["User"]` becomes `User`.
- The export block in `index.ts`, inside `dung-beetle:start` markers.
- The generated half of the surface list in `tests/dist/public-api.test.js`,
  inside the same markers. Every run prints the public names it added and
  removed, so the semver call still happens in review.

### The names

Function names come from the method and the path, never from `operationId`:
real documents emit `read_user_users__user_id__get` and
`agents/get-repo-public-key`.

| Request | Function |
| --- | --- |
| `GET /users` | `listUsers(query)` |
| `GET /users/{id}` | `getUser(id)` |
| `POST /users` | `createUser(input)` |
| `PUT /users/{id}` | `replaceUser(id, input)` |
| `PATCH /users/{id}` | `updateUser(id, patch)` |
| `DELETE /users/{id}` | `deleteUser(id)` |
| `GET /users/{id}/sessions` | `listUserSessions(id, query)` |
| `POST /users/{id}/activate` | `activateUser(id)` |

Three rules come from the document rather than from English, because English
alone gets them wrong: a path with items under it is a collection whatever its
noun looks like (`/codes_of_conduct` beside `/codes_of_conduct/{key}` is
`listCodesOfConduct`), a trailing parameter that qualifies an item joins the
name (`/gists/{gist_id}/{sha}` is `getGistBySha`), and a version prefix names
nothing (`/v1/payment_intents` is `listPaymentIntents` in `payment-intents.ts`).
`POST` on a single item reads as an update, which is what APIs that write with
`POST` mean.

Where two endpoints still want one name, the run stops and prints every
collision at once with a block to paste under `names` in the config. That
happens 5 times in Stripe's 589 endpoints and 27 times in GitHub's 1220.

### What it refuses, rather than guessing

- Anything that is not OpenAPI 3.0 or 3.1, Swagger 2.0 included.
- A document whose paths, parameters, responses or security schemes break the
  OpenAPI structure, or a `$ref` that does not resolve anywhere in it. Every
  problem is reported together in one `SpecProblemsError`. Structural
  complaints about a schema are left alone, because `openapi-typescript` reads
  schemas and is more forgiving than the letter of the specification: Stripe's
  document raises 618 of them (`nullable` with no `type`) and generates fine.
- A `trace` endpoint, because `HttpMethod` has no TRACE.
- A path parameter the document never declares, because its type is unknown.
- Overwriting a file it did not write.

### What it leaves out, and says so in the code

- Webhooks and callbacks, which describe calls arriving rather than calls a
  wrapper makes, and error responses, which arrive as an `HttpError` carrying
  the raw body.
- Every request media type but one where an endpoint offers several, JSON
  first. A body that is not JSON is taken as a `RequestBody` the caller builds,
  since a form or multipart encoding cannot be derived from a schema safely.
- Nothing for `matrix` or `label` query parameters, which describe path
  segments rather than query strings. Those properties are narrowed to the
  forms this client can send, and the function's documentation names them.
  Everything else the document asks for is built: a non-exploded array through
  `joined`, and a `deepObject` filter through `deepObject`, which is how
  Stripe's 352 filter parameters reach the URL as `created[gte]=`.
- Authentication. Each function's `@security` line says which scheme applies
  and exactly where the credential goes, including "None" where an endpoint
  overrides the document's requirement. No auth code is generated, because a
  credential is a header and headers already reach the client.

### What it has been run against

`npm test` generates from the fixtures and from the two real documents in
`tests/generator/corpus/`, compiles each result against the real `Operation`
with `tsc`, and checks that the modules checked into `src/` still match their
document. `npm run corpus` does the same for the two large documents, which it
fetches because they are too big to keep here; a scheduled workflow runs it
weekly, and it is kept out of the pull request checks so that a network failure
never blocks unrelated work.

| Document | Endpoints | Modules | Names to settle | Where |
| --- | --- | --- | --- | --- |
| Swagger petstore | 19 | 3 | 0 | `npm test` |
| Redocly museum (3.1) | 8 | 3 | 0 | `npm test` |
| Stripe | 589 | 76 | 5 | `npm run corpus` |
| GitHub REST | 1220 | 37 | 27 | `npm run corpus` |

Both failures worth having so far came from those documents rather than from
the fixtures: rejecting Stripe outright over 618 schema nits, and emitting
Stripe query filters that would not compile.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run build` | Compile `src/` + `index.ts` to `dist/` with type declarations. |
| `npm run typecheck` | Type-check the package, the generator and the tests without emitting. |
| `npm run generate` | Write resource modules from the document named in `dungbeetle.config.ts`. |
| `npm run corpus` | Fetch Stripe and the GitHub REST API, generate from both, and typecheck the result. |
| `npm run lint` | Run ESLint. |
| `npm run lint:fix` | Run ESLint and auto-fix what it can. |
| `npm test` | Run the test suite against the sources with the Node test runner via `tsx`. |
| `npm run test:dist` | Build, then run the tests that import `dist/` the way a consumer does. |
| `npm run docs` | Generate HTML API docs into `docs/` with TypeDoc. |
| `npm run changelog` | Regenerate `CHANGELOG.md` from the commit history with git-cliff. |

## Project layout

```
.
├── index.ts                    # public surface; everything else is internal
├── src/
│   ├── client.ts               # ApiClient, ApiClientOptions, Transport
│   ├── operation.ts            # Operation and its parameter types
│   ├── query.ts                # deepObject and joined, for query shapes buildUrl cannot build
│   ├── schema.ts               # generated: every type the document declares
│   ├── errors.ts               # ApiError and its three subclasses
│   ├── decode.ts               # readJson
│   ├── url.ts                  # internal URL and query building
│   └── resources/
│       ├── example.ts          # one worked resource; copy it, then delete it
│       └── users.ts            # generated from the fixture document; delete it too
├── dungbeetle.config.ts        # which document to read, and any names to override
├── tools/
│   ├── compile.ts              # writes generated modules into a throwaway project and runs tsc
│   ├── corpus.ts               # npm run corpus
│   └── generator/
│       ├── cli.ts              # npm run generate
│       ├── config.ts           # the config file's shape
│       ├── document.ts         # load(): OpenAPI document to NormalizedDocument
│       ├── model.ts            # the model the rest of the generator reads
│       ├── names.ts            # method and path to function and file names
│       ├── plan.ts             # every name settled before anything is written
│       ├── emit.ts             # the resource module source
│       ├── schema.ts           # src/schema.ts via openapi-typescript
│       └── surface.ts          # the managed regions in index.ts and the surface list
├── tests/
│   ├── client.test.ts
│   ├── example.test.ts
│   ├── generator/
│   │   ├── document.test.ts
│   │   ├── names.test.ts
│   │   ├── emit.test.ts
│   │   ├── cli.test.ts
│   │   ├── corpus.test.ts
│   │   ├── corpus/             # two real documents, with where they came from
│   │   └── fixtures/           # documents covering what the generator has to get right
│   ├── dist/
│   │   └── public-api.test.js  # consumes the build output (npm run test:dist)
│   └── tsconfig.json
├── eslint.config.mjs
├── tsconfig.json
├── typedoc.json                # TypeDoc config (npm run docs)
├── commitlint.config.js        # Conventional Commits rules
├── cliff.toml                  # git-cliff changelog config
├── lefthook.yml                # git hooks (lint + commitlint)
├── release.sh                  # version bump + changelog + annotated tag
├── .nvmrc                      # pinned Node version
├── .vscode/                    # recommended extensions + editor settings
└── .github/
    ├── ISSUE_TEMPLATE/         # bug report + feature request
    ├── workflows/ci.yml
    ├── workflows/corpus.yml    # weekly run against the large public documents
    └── dependabot.yml
```

## Tooling

- **ESM-native**: `"type": "module"`, `nodenext` module resolution,
  `verbatimModuleSyntax`, and `sideEffects: false`. Internal imports carry the
  `.js` extension because the specifier must match the emitted file.
- **Runtime**: needs `fetch`, `Request`, `Response`, `Headers` and `URL` as
  globals. It imports no `node:` built-ins and reads no `process`. CI runs Node
  22 and 24 on Linux, macOS and Windows; `engines` records that floor.
- **Dependencies**: none at runtime. `@redocly/openapi-core`,
  `openapi-typescript` and `pluralize` are devDependencies the generator uses,
  and `tools/` is not published, so installing this package installs nothing
  else. `openapi-typescript` declares a peer of TypeScript 5 and this project
  is on 6, which an `overrides` entry in `package.json` settles; it runs
  correctly on 6.
- **Testing**: Node's built-in test runner (`node:test` / `node:assert`) run
  against TypeScript via [`tsx`](https://tsx.is), plus a JavaScript suite under
  `tests/dist/` that imports the build output.
- **Linting**: flat ESLint config on `@eslint/js` and `typescript-eslint`
  recommended sets, plus project rules (tabs, double quotes, `no-console`,
  ignore-pattern-aware unused checks, return-type hints).
- **API docs**: [TypeDoc](https://typedoc.org) renders the TSDoc comments into
  `docs/` (`npm run docs`).
- **Conventional Commits**: `commitlint` enforces the
  [Conventional Commits](https://www.conventionalcommits.org) format, and
  [git-cliff](https://git-cliff.org) turns that history into a `CHANGELOG.md`
  (`npm run changelog`).
- **Git hooks**: [lefthook](https://lefthook.dev) runs ESLint on staged files
  before commit and lints the commit message. Installed by the `prepare` script
  on `npm install`, which needs a git repository, so run `git init` first if you
  copied the directory.
- **Dependabot**: daily npm + GitHub Actions update PRs.

## Publishing your client (manual)

Only `dist/` is published (`"files": ["dist"]` in `package.json`, with
`.npmignore` as a backstop), so `tools/`, your document and the generator's
configuration all stay behind. Build first, then publish with your custom npm
settings:

```sh
npm run build
npm publish   # with whatever registry/auth settings you use
```

To cut a release first, `./release.sh v[X.Y.Z]` bumps the version in
`package.json`, regenerates `CHANGELOG.md`, commits, and creates an annotated
tag. Then `git push && git push --tags` and publish as above.
