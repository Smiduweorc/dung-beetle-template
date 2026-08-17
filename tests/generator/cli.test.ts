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
		"export default { spec: \"./users.yaml\" };\n",
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
			"export default { spec: \"./broken.yaml\" };\n",
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
