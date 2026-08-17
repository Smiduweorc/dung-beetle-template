import { BANNER_MARK } from "./emit.js";
import { compare } from "./order.js";
import type { Plan, PlannedModule } from "./plan.js";

// Keeps the two places that list the package's public names in step with the
// generated modules: the export block in `index.ts` and the surface list the
// built-artifact test checks. Both are edited inside markers, so whatever a
// human wrote around them survives.

/**
 * A path with forward slashes, whatever the platform builds. Windows joins with
 * backslashes, which would emit `./src\resources/users.js` as an import
 * specifier and print paths no documented output matches. Git reports
 * repository paths the same way for the same reason.
 */
export function posix(path: string): string {
	return path.split(/[\\/]/u).join("/");
}

// A marker opens a line, after a comment token: `//` in TypeScript and
// JavaScript, `<!--` in markdown. Anchoring to the start of the line is what
// keeps prose that mentions `dung-beetle:start` from being read as one.
const START = /^[ \t]*(?:\/\/|<!--)[ \t]*dung-beetle:start\b/u;
const END = /^[ \t]*(?:\/\/|<!--)[ \t]*dung-beetle:end\b/u;

/** Everything one module exports, sorted so a re-run gives a readable diff. */
export function moduleExports(module: PlannedModule): {
	values: readonly string[];
	types: readonly string[];
} {
	const types = [
		...module.schemas.map((schema) => schema.name),
		...module.operations.flatMap((operation) =>
			[
				operation.queryType,
				operation.bodyType?.declared === true ? operation.bodyType.name : undefined,
				operation.resultType.declared ? operation.resultType.name : undefined,
			].filter((name) => name !== undefined)
		),
	];

	return {
		values: module.operations.map((operation) => operation.name).sort(compare),
		types: types.sort(compare),
	};
}

/** Every value the generated modules export, which is what `Object.keys` sees. */
export function generatedValues(plan: Plan): readonly string[] {
	return plan.modules.flatMap((module) => moduleExports(module).values).sort(compare);
}

/** The export block for `index.ts`. */
export function exportsRegion(plan: Plan, resources: string): string {
	const blocks = plan.modules.flatMap((module) => {
		const { values, types } = moduleExports(module);
		const from = `"./${resources}/${module.name}.js"`;

		return [
			values.length > 0 ? exportList("export", values, from) : undefined,
			types.length > 0 ? exportList("export type", types, from) : undefined,
		].filter((block) => block !== undefined);
	});

	return blocks.join("\n\n");
}

function exportList(keyword: string, names: readonly string[], from: string): string {
	return [`${keyword} {`, ...names.map((name) => `\t${name},`), `} from ${from};`].join("\n");
}

/**
 * The module the built-artifact test reads its half of the surface list from.
 *
 * A whole file rather than a region inside the test, so the generator never
 * edits a test someone wrote. The names still land in a diff, which is the
 * point of keeping the list at all.
 */
export function surfaceModule(plan: Plan, spec: string): string {
	return [
		`// ${BANNER_MARK} from ${spec}. Do not edit.`,
		"//",
		"// Every value the generated modules export. The built-artifact test checks",
		"// the package against this, so a name arriving or leaving is a change to the",
		"// public API and shows up in review.",
		"",
		"export const generatedSurface = [",
		...generatedValues(plan).map((name) => `\t${JSON.stringify(name)},`),
		"];",
		"",
	].join("\n");
}

/** The names the last run wrote, for reporting what this one changed. */
export function namesIn(source: string): readonly string[] {
	return [...source.matchAll(/"([^"]+)"/gu)].map((match) => match[1] ?? "");
}

/** Whether a file carries the markers, which is how a README opts in. */
export function hasRegion(source: string): boolean {
	return between(source) !== undefined;
}

/**
 * Replaces what sits between a file's markers, adding a region at the end if
 * the file has none. Both marker lines are left exactly as written, so a
 * markdown file keeps its `<!-- -->` and whatever note the author put there.
 */
export function withRegion(source: string, content: string, note: string): string {
	const lines = source.split("\n");
	const start = lines.findIndex((line) => START.test(line));
	const end = lines.findIndex((line) => END.test(line));

	if (start === -1 || end === -1 || end < start) {
		return `${source.replace(/\n+$/u, "")}\n\n// dung-beetle:start ${note}\n${content}\n// dung-beetle:end\n`;
	}

	return [
		...lines.slice(0, start + 1),
		...content.split("\n"),
		...lines.slice(end),
	].join("\n");
}

function between(source: string): string | undefined {
	const lines = source.split("\n");
	const start = lines.findIndex((line) => START.test(line));
	const end = lines.findIndex((line) => END.test(line));

	return start === -1 || end === -1 || end < start
		? undefined
		: lines.slice(start + 1, end).join("\n");
}
