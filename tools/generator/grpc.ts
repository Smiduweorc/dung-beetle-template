import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { SpecError } from "./document.js";
import { BANNER_MARK } from "./emit.js";
import { compare } from "./order.js";
import { PlanError } from "./plan.js";
import { posix } from "./surface.js";

// `.proto` files go through `buf generate` and `protoc-gen-es`, the generator
// Connect-ES is built on, and nothing here reads protobuf itself: descriptor
// encoding, well-known types and JSON names have one correct answer, and it
// lives in those two packages. What this file adds is the banner, the barrel
// and the check that no two files export the same name.

/** One file `protoc-gen-es` wrote, keyed by its path under `src/grpc/`. */
export interface ProtoModule {
	/** Path under `src/grpc/` with forward slashes, such as `widgets/v1/widgets_pb.ts`. */
	readonly path: string;

	readonly source: string;

	/** Message and service descriptors, enums and the file descriptor. */
	readonly values: readonly string[];

	/** Message types. */
	readonly types: readonly string[];
}

const require = createRequire(import.meta.url);

/**
 * Runs `buf generate` over the `.proto` files under `protos` and returns what
 * `protoc-gen-es` wrote, with the generator's banner on top.
 *
 * @throws {SpecError} If `protos` is not a directory or `buf` refuses the files.
 * @throws {PlanError} If two files export the same name, which one barrel cannot hold.
 */
export async function generateProtos(protos: string, label: string): Promise<readonly ProtoModule[]> {
	if (!(await stat(protos).then((entry) => entry.isDirectory(), () => false))) {
		throw new SpecError(`${label} is not a directory of .proto files.`, { spec: label });
	}

	const out = await mkdtemp(join(tmpdir(), "dung-beetle-grpc-"));
	try {
		const template = {
			version: "v2",
			plugins: [
				{
					local: [process.execPath, require.resolve("@bufbuild/protoc-gen-es/bin/protoc-gen-es")],
					out,
					opt: ["target=ts", "import_extension=js"],
				},
			],
		};
		const buf = spawnSync(
			process.execPath,
			[require.resolve("@bufbuild/buf/bin/buf"), "generate", protos, "--template", JSON.stringify(template)],
			{ encoding: "utf8" }
		);
		if (buf.status !== 0) {
			const reason = `${buf.stderr ?? ""}${buf.error?.message ?? ""}`.trim();
			throw new SpecError(`buf could not generate from ${label}:\n${reason}`, { spec: label });
		}

		const files = (await walk(out)).sort(compare);
		if (files.length === 0) {
			throw new SpecError(`${label} holds no .proto files.`, { spec: label });
		}

		const modules = await Promise.all(
			files.map(async (file): Promise<ProtoModule> => {
				const source = await readFile(file, "utf8");
				return {
					path: posix(relative(out, file)),
					source: `// ${BANNER_MARK} from ${label} through protoc-gen-es. Do not edit.\n${source}`,
					values: [...source.matchAll(/^export (?:const|enum) (\w+)/gmu)].map((match) => match[1] ?? ""),
					types: [...source.matchAll(/^export type (\w+)/gmu)].map((match) => match[1] ?? ""),
				};
			})
		);

		const owner = new Map<string, string>();
		const clashes: string[] = [];
		for (const module of modules) {
			for (const name of [...module.values, ...module.types]) {
				const held = owner.get(name);
				if (held === undefined) {
					owner.set(name, module.path);
				} else {
					clashes.push(`  ${name} is exported by both ${held} and ${module.path}`);
				}
			}
		}
		if (clashes.length > 0) {
			throw new PlanError(
				[
					"The grpc subpath exports every generated name from one module, and these clash:",
					...clashes,
					"Rename one of the messages, or keep the packages in separate builds.",
				].join("\n")
			);
		}

		return modules;
	} finally {
		await rm(out, { recursive: true, force: true });
	}
}

async function walk(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map((entry) =>
			entry.isDirectory() ? walk(join(directory, entry.name)) : Promise.resolve([join(directory, entry.name)])
		)
	);

	return nested.flat();
}
