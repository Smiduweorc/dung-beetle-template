import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { posix } from "../../tools/generator/surface.js";

const root = dirname(dirname(import.meta.dirname));
const cli = join(root, "tools", "generator", "cli.ts");

interface Run {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

function run(args: readonly string[]): Run {
	const result = spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
		cwd: root,
		encoding: "utf8",
	});

	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A project laid out the way the template is, with one document to read. */
async function project(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "dung-beetle-cli-"));

	await mkdir(join(directory, "src", "resources"), { recursive: true });
	await mkdir(join(directory, "tests", "dist"), { recursive: true });
	await cp(
		join(import.meta.dirname, "fixtures", "users.yaml"),
		join(directory, "users.yaml")
	);
	await cp(
		join(import.meta.dirname, "fixtures", "new-user.yaml"),
		join(directory, "new-user.yaml")
	);
	await writeFile(
		join(directory, "dungbeetle.config.ts"),
		"export default { openapi: { spec: \"./users.yaml\" } };\n",
		"utf8"
	);
	await writeFile(
		join(directory, "package.json"),
		`${JSON.stringify({ name: "fixture", type: "module", exports: { ".": "./dist/index.js" } }, null, "\t")}\n`,
		"utf8"
	);
	await writeFile(
		join(directory, "index.ts"),
		"export { ApiClient } from \"./src/client.js\";\n",
		"utf8"
	);
	await writeFile(
		join(directory, "tests", "dist", "public-api.test.js"),
		"const generatedSurface = [];\n",
		"utf8"
	);

	return directory;
}

function config(directory: string): string {
	return join(directory, "dungbeetle.config.ts");
}

test("reported paths use forward slashes, whatever the platform joined them with", () => {
	// What the CLI prints, and what it writes into `index.ts` as an import
	// specifier. On Windows both are built with backslashes.
	assert.equal(posix("src\\resources\\users.ts"), "src/resources/users.ts");
	assert.equal(posix("src/resources/users.ts"), "src/resources/users.ts");
});

test("--help explains the command and exits zero", () => {
	const help = run(["--help"]);

	assert.equal(help.status, 0);
	assert.match(help.stderr, /Usage: npm run generate/u);
	assert.equal(help.stdout, "");
});

test("an unknown flag is a usage error, not a failed run", () => {
	const bad = run(["--wat"]);

	assert.equal(bad.status, 2);
	assert.match(bad.stderr, /--wat/u);
});

test("a configuration file that is not there is reported, not thrown", () => {
	const missing = run(["--config", join(tmpdir(), "no-such-dungbeetle.config.ts")]);

	assert.equal(missing.status, 1);
	assert.match(missing.stderr, /Could not read/u);
	assert.equal(missing.stdout, "");
});

test("a document that is not valid stops the run before anything is written", async () => {
	const directory = await project();

	try {
		await writeFile(
			config(directory),
			"export default { openapi: { spec: \"./broken.yaml\" } };\n",
			"utf8"
		);
		await cp(
			join(import.meta.dirname, "fixtures", "broken.yaml"),
			join(directory, "broken.yaml")
		);

		const failed = run(["--config", config(directory)]);

		assert.equal(failed.status, 1);
		assert.match(failed.stderr, /problems/u);
		assert.deepEqual(await readdir(join(directory, "src", "resources")), []);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a run writes the modules, the schema and both managed regions", async () => {
	const directory = await project();

	try {
		const generated = run(["--config", config(directory)]);

		assert.equal(generated.status, 0);
		assert.equal(generated.stdout, "");
		assert.match(generated.stderr, /public names added: createUser/u);

		assert.deepEqual(await readdir(join(directory, "src", "resources")), ["users.ts"]);
		assert.match(
			await readFile(join(directory, "index.ts"), "utf8"),
			/dung-beetle:start[\s\S]*listUsers[\s\S]*dung-beetle:end/u
		);
		assert.match(
			await readFile(join(directory, "tests", "dist", "public-api.test.js"), "utf8"),
			/const generatedSurface = \[\n\t"createUser",/u
		);

		// The second run has nothing to say, which is what makes the first one
		// reviewable as a diff.
		const again = run(["--config", config(directory)]);
		assert.match(again.stderr, /users\.ts unchanged/u);
		assert.match(again.stderr, /public names added: none/u);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("--dry-run reports the same work and writes none of it", async () => {
	const directory = await project();

	try {
		const dry = run(["--config", config(directory), "--dry-run"]);

		assert.equal(dry.status, 0);
		assert.match(dry.stderr, /src\/resources\/users\.ts would write/u);
		assert.deepEqual(await readdir(join(directory, "src", "resources")), []);
		assert.equal(
			await readFile(join(directory, "index.ts"), "utf8"),
			"export { ApiClient } from \"./src/client.js\";\n"
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a hand-written resource of the same name is refused rather than overwritten", async () => {
	const directory = await project();
	const mine = join(directory, "src", "resources", "users.ts");

	try {
		await writeFile(mine, "export function listUsers() {}\n", "utf8");

		const refused = run(["--config", config(directory)]);

		assert.equal(refused.status, 1);
		assert.match(refused.stderr, /was not written by this generator/u);
		assert.equal(await readFile(mine, "utf8"), "export function listUsers() {}\n");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a module the document no longer describes is removed, and only if it was generated", async () => {
	const directory = await project();
	const stale = join(directory, "src", "resources", "gone.ts");
	const mine = join(directory, "src", "resources", "mine.ts");

	try {
		run(["--config", config(directory)]);
		await writeFile(
			stale,
			"// @generated by dung beetle from ./users.yaml. Do not edit.\n",
			"utf8"
		);
		await writeFile(mine, "export const mine = 1;\n", "utf8");

		const second = run(["--config", config(directory)]);

		assert.equal(second.status, 0);
		assert.match(second.stderr, /gone\.ts removed/u);
		assert.deepEqual((await readdir(join(directory, "src", "resources"))).sort(), [
			"mine.ts",
			"users.ts",
		]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("--spec reads a document the configuration does not name", async () => {
	const directory = await project();
	const widgets = join(import.meta.dirname, "fixtures", "widgets.yaml");

	try {
		// The configuration still points at users.yaml, so what lands is the
		// measure of which document was read.
		const generated = run(["--config", config(directory), "--spec", widgets]);

		assert.equal(generated.status, 0);
		assert.deepEqual((await readdir(join(directory, "src", "resources"))).sort(), [
			"gadgets.ts",
			"widgets.ts",
		]);
		assert.match(generated.stderr, /public names added: .*listWidgets/u);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("--spec leaves the rest of the configuration in force", async () => {
	const directory = await project();
	const widgets = join(import.meta.dirname, "fixtures", "widgets.yaml");

	try {
		await writeFile(
			config(directory),
			"export default { openapi: { spec: \"./users.yaml\", names: { \"GET /widgets\": \"listAllWidgets\" } } };\n",
			"utf8"
		);

		const generated = run(["--config", config(directory), "--spec", widgets]);

		assert.equal(generated.status, 0);
		assert.match(generated.stderr, /public names added: .*listAllWidgets/u);
		assert.doesNotMatch(generated.stderr, /listWidgets\b/u);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("--spec alone generates where there is no configuration file", async () => {
	const directory = await mkdtemp(join(tmpdir(), "dung-beetle-cli-"));
	const widgets = join(import.meta.dirname, "fixtures", "widgets.yaml");

	try {
		const generated = run(["--config", config(directory), "--spec", widgets]);

		assert.equal(generated.status, 0);
		assert.match(generated.stderr, /no dungbeetle\.config\.ts/u);
		assert.deepEqual((await readdir(join(directory, "src", "resources"))).sort(), [
			"gadgets.ts",
			"widgets.ts",
		]);

		// Neither managed region is there to update, which is reported rather
		// than fatal.
		assert.match(generated.stderr, /index\.ts is missing/u);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a configuration file that is not there is still an error without --spec", async () => {
	const missing = run(["--config", join(tmpdir(), "no-such-dungbeetle.config.ts")]);

	assert.equal(missing.status, 1);
	assert.match(missing.stderr, /Could not read/u);
});

test("--spec with nothing after it is a usage error", () => {
	const empty = run(["--spec", ""]);

	assert.equal(empty.status, 2);
	assert.match(empty.stderr, /--spec needs a path or a URL/u);
});

/** The project above, with the OpenRPC and gRPC fixtures beside it and `config` as its configuration. */
async function protocols(configuration: string, dependencies?: Record<string, string>): Promise<string> {
	const directory = await project();

	await cp(join(import.meta.dirname, "fixtures", "ledger.openrpc.json"), join(directory, "ledger.json"));
	await cp(join(import.meta.dirname, "fixtures", "protos"), join(directory, "protos"), { recursive: true });
	await writeFile(config(directory), configuration, "utf8");
	await writeFile(
		join(directory, "package.json"),
		`${JSON.stringify({ name: "fixture", type: "module", exports: { ".": "./dist/index.js" }, dependencies }, null, "\t")}\n`,
		"utf8"
	);

	return directory;
}

const ALL = "export default { openapi: { spec: \"./users.yaml\" }, openrpc: { spec: \"./ledger.json\" }, grpc: { protos: \"./protos\" } };\n";
const PROTOBUF = { "@bufbuild/protobuf": "^2.0.0" };

async function manifest(directory: string): Promise<{ exports: Record<string, unknown> }> {
	return JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as { exports: Record<string, unknown> };
}

async function exists(path: string): Promise<boolean> {
	return await readFile(path).then(() => true, () => false);
}

test("every configured protocol is written, with its subpath export and surface test", async () => {
	const directory = await protocols(ALL, PROTOBUF);

	try {
		const generated = run(["--config", config(directory)]);

		assert.equal(generated.status, 0, generated.stderr);
		assert.deepEqual((await readdir(join(directory, "src", "methods"))).sort(), ["ledger.ts", "methods.ts", "types.ts"]);
		assert.ok(await exists(join(directory, "src", "rpc-schema.ts")));
		assert.ok(await exists(join(directory, "src", "grpc", "widgets", "v1", "widgets_pb.ts")));
		assert.match(await readFile(join(directory, "openrpc.ts"), "utf8"), /ledgerTransfer,/u);
		assert.match(await readFile(join(directory, "grpc.ts"), "utf8"), /WidgetService,/u);
		assert.match(await readFile(join(directory, "tests", "dist", "openrpc.test.js"), "utf8"), /from "fixture\/openrpc"/u);
		assert.match(await readFile(join(directory, "tests", "dist", "grpc.test.js"), "utf8"), /from "fixture\/grpc"/u);
		assert.deepEqual((await manifest(directory)).exports, {
			".": "./dist/index.js",
			"./openrpc": { types: "./dist/types/openrpc.d.ts", default: "./dist/openrpc.js" },
			"./grpc": { types: "./dist/types/grpc.d.ts", default: "./dist/grpc.js" },
		});
		assert.match(generated.stderr, /ledger_balanceChanged has no result, so it is a notification and was not generated/u);

		const again = run(["--config", config(directory)]);
		assert.doesNotMatch(again.stderr, /written/u);
		assert.match(again.stderr, /package\.json unchanged/u);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a protocol taken out of the configuration takes its files and its export with it", async () => {
	const directory = await protocols(ALL, PROTOBUF);
	const mine = join(directory, "src", "methods", "mine.ts");

	try {
		run(["--config", config(directory)]);
		await writeFile(mine, "export const mine = 1;\n", "utf8");
		await writeFile(config(directory), "export default { openapi: { spec: \"./users.yaml\" } };\n", "utf8");
		await writeFile(
			join(directory, "package.json"),
			`${JSON.stringify({ ...(await manifest(directory)), dependencies: {} }, null, "\t")}\n`,
			"utf8"
		);

		const reduced = run(["--config", config(directory)]);

		assert.equal(reduced.status, 0, reduced.stderr);
		assert.deepEqual(await readdir(join(directory, "src", "methods")), ["mine.ts"]);
		for (const gone of ["openrpc.ts", "grpc.ts", "src/rpc-schema.ts", "tests/dist/openrpc.test.js", "tests/dist/grpc.test.js", "src/grpc/widgets/v1/widgets_pb.ts", "src/grpc/common/v1/money_pb.ts"]) {
			assert.equal(await exists(join(directory, ...gone.split("/"))), false, gone);
		}
		assert.match(reduced.stderr, /grpc\.ts removed, the configuration no longer produces it/u);
		assert.deepEqual((await manifest(directory)).exports, { ".": "./dist/index.js" });
		assert.ok(await exists(join(directory, "src", "resources", "users.ts")));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("gRPC without @bufbuild/protobuf in dependencies is refused before anything is written", async () => {
	const directory = await protocols("export default { grpc: { protos: \"./protos\" } };\n");

	try {
		const refused = run(["--config", config(directory)]);

		assert.equal(refused.status, 1);
		assert.match(refused.stderr, /npm install @bufbuild\/protobuf@\^2/u);
		assert.equal(await exists(join(directory, "grpc.ts")), false);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("@bufbuild/protobuf without gRPC configured is refused, since consumers would install it for nothing", async () => {
	const directory = await protocols("export default { openapi: { spec: \"./users.yaml\" } };\n", PROTOBUF);

	try {
		const refused = run(["--config", config(directory)]);

		assert.equal(refused.status, 1);
		assert.match(refused.stderr, /npm uninstall @bufbuild\/protobuf/u);
		assert.deepEqual(await readdir(join(directory, "src", "resources")), []);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("OpenRPC without a package.json is refused, since its subpath lives in exports", async () => {
	const directory = await protocols("export default { openrpc: { spec: \"./ledger.json\" } };\n");

	try {
		await rm(join(directory, "package.json"));
		const refused = run(["--config", config(directory)]);

		assert.equal(refused.status, 1);
		assert.match(refused.stderr, /There is no package\.json/u);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a document refused in one protocol leaves the others unwritten", async () => {
	const directory = await protocols(
		"export default { openapi: { spec: \"./users.yaml\" }, openrpc: { spec: \"./missing.json\" } };\n"
	);

	try {
		const refused = run(["--config", config(directory)]);

		assert.equal(refused.status, 1);
		assert.match(refused.stderr, /Could not read an OpenRPC document/u);
		assert.deepEqual(await readdir(join(directory, "src", "resources")), []);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a misspelled configuration key is a refusal naming the key", async () => {
	const directory = await protocols("export default { openapi: { spec: \"./users.yaml\", nmaes: {} } };\n");

	try {
		const refused = run(["--config", config(directory)]);

		assert.equal(refused.status, 1);
		assert.match(refused.stderr, /`openapi\.nmaes`/u);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("--spec is refused when the configuration has no openapi to replace", async () => {
	const directory = await protocols("export default { openrpc: { spec: \"./ledger.json\" } };\n");

	try {
		const refused = run(["--config", config(directory), "--spec", "./users.yaml"]);

		assert.equal(refused.status, 1);
		assert.match(refused.stderr, /--spec replaces `openapi\.spec`/u);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
