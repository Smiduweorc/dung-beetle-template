import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Writes generated modules into a throwaway project and runs `tsc` over them.
// If the output compiles against the real `Operation`, `readJson` and the query
// builders, it is sound; nothing else the generator does is worth much if this
// fails. Used by the tests and by the corpus script.

const root = dirname(import.meta.dirname);

export interface Compilation {
	readonly ok: boolean;

	/** `tsc` output, empty when it had nothing to say. */
	readonly errors: string;
}

/**
 * Compiles `files`, keyed `schema.ts` for the schema module and `<name>.ts`
 * for each resource module.
 *
 * The project is built with the DOM lib rather than `@types/node`, so this also
 * checks that generated code compiles for a consumer building for the browser.
 */
export async function compileGenerated(
	files: ReadonlyMap<string, string>
): Promise<Compilation> {
	const directory = await mkdtemp(join(tmpdir(), "dung-beetle-"));

	try {
		await mkdir(join(directory, "src", "resources"), { recursive: true });

		// Every runtime module, read rather than listed, so adding one does not
		// quietly leave this checking a stale copy of the runtime.
		for (const file of await readdir(join(root, "src"), { withFileTypes: true })) {
			if (file.isFile() && file.name.endsWith(".ts") && file.name !== "schema.ts") {
				await cp(join(root, "src", file.name), join(directory, "src", file.name));
			}
		}

		for (const [name, source] of files) {
			const path =
				name === "schema.ts"
					? join(directory, "src", name)
					: join(directory, "src", "resources", name);

			await writeFile(path, source, "utf8");
		}

		await writeFile(
			join(directory, "package.json"),
			JSON.stringify({ name: "generated", type: "module" }),
			"utf8"
		);
		await writeFile(
			join(directory, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: {
					target: "es2022",
					lib: ["es2022", "dom"],
					module: "nodenext",
					moduleResolution: "nodenext",
					types: [],
					strict: true,
					noUncheckedIndexedAccess: true,
					verbatimModuleSyntax: true,
					noEmit: true,
					skipLibCheck: true,
				},
				include: ["src/**/*.ts"],
			}),
			"utf8"
		);

		const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
		const compiled = spawnSync(process.execPath, [tsc, "--project", directory], {
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
		});

		// `tsc` reports with forward slashes even where the directory was joined
		// with backslashes, so both forms are trimmed. A Windows failure that
		// prints full temporary paths is a round trip nobody needs.
		const posix = directory.split(/[\\/]/u).join("/");

		return {
			ok: compiled.status === 0,
			errors: compiled.stdout.trim().replaceAll(directory, ".").replaceAll(posix, "."),
		};
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
