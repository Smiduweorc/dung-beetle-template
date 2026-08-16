import openapiTS, { astToString, type OpenAPI3 } from "openapi-typescript";

import { BANNER_MARK } from "./emit.js";

/**
 * The source of `src/schema.ts`: every type the document declares, written by
 * `openapi-typescript`.
 *
 * Nobody edits that file and resource modules alias into it, so the schema
 * algebra (`allOf`, `oneOf`, discriminators, `nullable`, `readOnly`) belongs to
 * a generator that has years of bug reports behind it rather than to this one.
 *
 * `--immutable` is on, which is what gives the `readonly` modifiers the
 * resource convention wants, on array types as well as properties.
 */
export async function emitSchema(bundled: unknown, spec: string): Promise<string> {
	// `document.ts` has already bundled and checked this; `openapi-typescript`
	// takes the document object under its own type for the same shape.
	const ast = await openapiTS(bundled as OpenAPI3, { immutable: true });

	return [
		`// ${BANNER_MARK} from ${spec}. Do not edit.`,
		"//",
		"// Every type the document declares. Resource modules alias into it, so a",
		"// name here is only public where one of them exports it.",
		"",
		astToString(ast),
	].join("\n");
}
