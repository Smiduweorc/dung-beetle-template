import type { GeneratorConfig } from "./tools/generator/config.js";

/**
 * Keep the protocols your API speaks, point each at its own description, and
 * run `npm run generate`. A protocol left out here is left out of the package.
 *
 * It ships pointed at the fixtures the generator's own tests use, so the
 * command works in a fresh copy of this template and you can read its output
 * before replacing it.
 */
const config: GeneratorConfig = {
	openapi: {
		spec: "./tests/generator/fixtures/users.yaml",

		// Names the path rules read wrongly, and two endpoints that would collide.
		names: {},
	},

	openrpc: {
		spec: "./tests/generator/fixtures/ledger.openrpc.json",
	},

	grpc: {
		protos: "./tests/generator/fixtures/protos",
	},
};

export default config;
