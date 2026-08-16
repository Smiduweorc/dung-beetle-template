# @Smiduweorc/AphidTemplate

![logo](./assets/logo.jpeg)

A TypeScript skeleton for wrapping an HTTP API: you describe each endpoint as a
typed value, and a client turns that description into a request, sends it
through a transport you supply, and decodes the response.

> Publishing and deployment are handled manually (custom npm settings), so no
> release/publish workflow is included here.

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
  wire names.
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

## Install and use

```sh
npm install @Smiduweorc/AphidTemplate
```

```ts
import { ApiClient, HttpError, listExamples } from "@Smiduweorc/AphidTemplate";

const api = new ApiClient({
	baseUrl: "https://api.example.com/v1",
	headers: { authorization: `Bearer ${token}` },
});

try {
	const page = await api.request(listExamples({ perPage: 50 }));
	console.log(page.data, page.meta.total);
} catch (error) {
	if (error instanceof HttpError && error.status === 404) {
		// error.body holds the API's own error payload
	}
	throw error;
}
```

## Writing a wrapper

### Operations and the client

An operation is a plain object. Building one touches nothing, which is what
makes the request side testable without a network:

```ts
import type { Operation } from "@Smiduweorc/AphidTemplate";

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

## Getting started from this template

1. Copy this directory, run `git init` (if needed), then `npm install`, which
   also installs the git hooks via the `prepare` script.
2. Update `package.json` (`name`, `description`, `repository`, `keywords`).
3. Replace `src/resources/example.ts` with your first resource, then update the
   exports in `index.ts` and the `publicSurface` list in
   `tests/dist/public-api.test.js`, which records what the package exports.
4. Add tests under `tests/` as `*.test.ts`.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run build` | Compile `src/` + `index.ts` to `dist/` with type declarations. |
| `npm run typecheck` | Type-check the sources and the tests without emitting. |
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
│   ├── errors.ts               # ApiError and its three subclasses
│   ├── decode.ts               # readJson
│   ├── url.ts                  # internal URL and query building
│   └── resources/
│       └── example.ts          # one worked resource; copy it, then delete it
├── tests/
│   ├── client.test.ts
│   ├── example.test.ts
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
    └── dependabot.yml
```

## Tooling

- **ESM-native**: `"type": "module"`, `nodenext` module resolution,
  `verbatimModuleSyntax`, and `sideEffects: false`. Internal imports carry the
  `.js` extension because the specifier must match the emitted file.
- **Runtime**: needs `fetch`, `Request`, `Response`, `Headers` and `URL` as
  globals. It imports no `node:` built-ins and reads no `process`. CI runs Node
  22 and 24 on Linux, macOS and Windows; `engines` records that floor.
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

## Publishing (manual)

Only `dist/` is published (`"files": ["dist"]` in `package.json`, with
`.npmignore` as a backstop). Build first, then publish with your custom npm
settings:

```sh
npm run build
npm publish   # with whatever registry/auth settings you use
```

To cut a release first, `./release.sh v[X.Y.Z]` bumps the version in
`package.json`, regenerates `CHANGELOG.md`, commits, and creates an annotated
tag. Then `git push && git push --tags` and publish as above.
