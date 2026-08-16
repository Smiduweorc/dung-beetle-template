import type { QueryParams } from "./operation.js";

/**
 * Joins `path` onto the base URL's path instead of replacing it, so a base of
 * `https://api.example.com/v1` and a path of `/items` gives
 * `https://api.example.com/v1/items`. Query parameters already on the base URL
 * are kept and the operation's are appended.
 *
 * Internal: not part of the published surface.
 */
export function buildUrl(base: URL, path: string, query?: QueryParams): URL {
	const url = new URL(base);
	const basePath = url.pathname.replace(/\/+$/u, "");
	const relativePath = path.replace(/^\/+/u, "");

	url.pathname = relativePath ? `${basePath}/${relativePath}` : basePath || "/";

	if (query) {
		for (const [key, value] of Object.entries(query)) {
			if (value === undefined || value === null) {
				continue;
			}

			if (typeof value === "object") {
				for (const item of value) {
					url.searchParams.append(key, String(item));
				}
				continue;
			}

			url.searchParams.append(key, String(value));
		}
	}

	return url;
}
