import { compare } from "./order.js";
import type { Plan, PlannedModule } from "./plan.js";

// Keeps the two places that list the package's public names in step with the
// generated modules: the export block in `index.ts` and the surface list the
// built-artifact test checks. Both are edited inside markers, so whatever a
// human wrote around them survives.

const START = "// dung-beetle:start";
const END = "// dung-beetle:end";

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

/** The generated half of the surface list the built-artifact test compares against. */
export function surfaceRegion(plan: Plan): string {
	const names = generatedValues(plan);

	return [
		"const generatedSurface = [",
		...names.map((name) => `\t${JSON.stringify(name)},`),
		"];",
	].join("\n");
}

/** The names inside a file's marked region, which is what the last run wrote. */
export function previousValues(source: string): readonly string[] {
	const region = between(source);

	return region === undefined ? [] : [...region.matchAll(/"([^"]+)"/gu)].map((match) => match[1] ?? "");
}

/**
 * Replaces a file's marked region, adding one at the end if the file has none.
 * A file the generator has never touched keeps everything it already said.
 */
export function withRegion(source: string, content: string, note: string): string {
	const marked = `${START} ${note}\n${content}\n${END}`;
	const start = source.indexOf(START);
	const end = source.indexOf(END);

	if (start === -1 || end === -1 || end < start) {
		return `${source.replace(/\n+$/u, "")}\n\n${marked}\n`;
	}

	return `${source.slice(0, start)}${marked}${source.slice(end + END.length)}`;
}

function between(source: string): string | undefined {
	const start = source.indexOf(START);
	const end = source.indexOf(END);

	return start === -1 || end === -1 || end < start
		? undefined
		: source.slice(start + START.length, end);
}
