import { spawnSync } from "node:child_process";
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { load } from "../tools/generator/document.js";
import { emitModule } from "../tools/generator/emit.js";
import { generateProtos } from "../tools/generator/grpc.js";
import { emitRpcModule, emitRpcSchema, emitRpcTypes, loadRpc, planRpc } from "../tools/generator/openrpc.js";
import { plan } from "../tools/generator/plan.js";
import { emitSchema } from "../tools/generator/schema.js";

// Generates a client for three real public APIs, one per protocol, then calls
// each of them over the network with what it generated:
//
// - OpenAPI: the Arch User Repository, from the document it serves itself.
// - OpenRPC: a public Ethereum node, from `ethereum.openrpc.json`.
// - gRPC: Connect's Eliza demo, from `protos/`.
//
// The output goes to `examples/.generated/`, which is ignored, and `calls.ts`
// is type-checked against it before it runs, so a call that no longer matches
// what the API describes fails here rather than at the server. Kept out of
// `npm test` for the same reason the corpus is: it needs the internet.

const here = import.meta.dirname;
const out = join(here, ".generated");
const src = join(out, "src");

const AUR = "https://aur.archlinux.org/rpc/openapi.json";
const ETHEREUM = "./examples/ethereum.openrpc.json";
const ELIZA = "./examples/protos";

function say(line: string): void {
	process.stdout.write(`${line}\n`);
}

async function emit(path: string, source: string): Promise<void> {
	await mkdir(dirname(join(src, path)), { recursive: true });
	await writeFile(join(src, path), source, "utf8");
}

await rm(out, { recursive: true, force: true });
await mkdir(src, { recursive: true });

// The runtime is copied as a fresh copy of this template would have it.
for (const file of await readdir(join(here, "..", "src"), { withFileTypes: true })) {
	if (file.isFile() && file.name.endsWith(".ts") && file.name !== "schema.ts" && file.name !== "rpc-schema.ts") {
		await cp(join(here, "..", "src", file.name), join(src, file.name));
	}
}

const aur = await load(AUR);
const names = {
	"GET /rpc/v5/search/{arg}": "searchPackages",
	"GET /rpc/v5/info/{arg}": "getPackage",
	"GET /rpc/v5/info": "listPackages",
	"POST /rpc/v5/info": "listPackagesByPost",
	"GET /rpc/v5/suggest/{arg}": "suggestPackageNames",
	"GET /rpc/v5/suggest-pkgbase/{arg}": "suggestPackageBases",
};
await emit("schema.ts", await emitSchema(aur.bundled, AUR));
for (const module of plan(aur.model, { names }).modules) {
	await emit(join("resources", `${module.name}.ts`), emitModule(module, aur.model, { spec: AUR }));
}

const ethereum = await loadRpc(join(here, "ethereum.openrpc.json"));
const rpcPlan = planRpc(ethereum, { names: { eth_chainId: "chainId", eth_blockNumber: "blockNumber", eth_getBalance: "getBalance" } });
await emit("rpc-schema.ts", await emitRpcSchema(ethereum, ETHEREUM));
if (rpcPlan.schemas.length > 0) {
	await emit(join("methods", "types.ts"), emitRpcTypes(rpcPlan, ETHEREUM));
}
for (const module of rpcPlan.modules) {
	await emit(join("methods", `${module.name}.ts`), emitRpcModule(module, ETHEREUM));
}

for (const module of await generateProtos(join(here, "protos"), ELIZA)) {
	await emit(join("grpc", ...module.path.split("/")), module.source);
}

await cp(join(here, "calls.ts"), join(out, "calls.ts"));
await writeFile(
	join(out, "tsconfig.json"),
	JSON.stringify({
		extends: "../../tsconfig.json",
		compilerOptions: { noEmit: true, rootDir: "." },
		include: ["calls.ts", "src/**/*.ts"],
		exclude: [],
	}),
	"utf8"
);
say("generated into examples/.generated/");

const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const compiled = spawnSync(process.execPath, [tsc, "--project", out], { encoding: "utf8" });
if (compiled.status !== 0) {
	say(compiled.stdout.trim());
	process.exit(1);
}
say("calls.ts type-checks against it\n");

const { run } = (await import(join(out, "calls.ts"))) as { run: (log: typeof say) => Promise<void> };
await run(say);
