// Optional transport decorators, reached at `<package>/transport` rather than
// from the root. Importing the package costs nothing unless you import this
// subpath, and `ApiClient` is untouched either way: a decorator is a plain
// `Transport` wrapped around another, which the consumer constructs and passes
// in. What the wrapper refuses to do on its own, it still lets you install.
//
// A copy of this template that wants none of them deletes this directory, the
// same way it deletes `src/resources/example.ts`.

export { withBearerToken } from "./bearer.js";
export type { TokenSource } from "./bearer.js";

export { withRetry } from "./retry.js";
export type { RetryOptions } from "./retry.js";
