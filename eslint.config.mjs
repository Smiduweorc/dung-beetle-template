import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{
		// `src/schema.ts` and `src/rpc-schema.ts` are openapi-typescript's output,
		// and `src/grpc/` is protoc-gen-es's, each written in its generator's style
		// and never edited by hand. The modules this generator writes are linted,
		// since matching this project's style is the point of generating them.
		ignores: ["dist/**", "docs/**", "node_modules/**", "src/schema.ts", "src/rpc-schema.ts", "src/grpc/**"],
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ["**/*.{js,mjs,cjs,ts,tsx}"],
		languageOptions: {
			parser: tseslint.parser,
			// Web-standard globals the package uses. TypeScript files get these
			// from @types/node; plain JavaScript needs them declared here.
			globals: {
				AbortSignal: "readonly",
				fetch: "readonly",
				FormData: "readonly",
				Headers: "readonly",
				Request: "readonly",
				Response: "readonly",
				URL: "readonly",
				URLSearchParams: "readonly",
			},
		},
		rules: {
			quotes: ["error", "double"],
			indent: ["error", "tab"],
			"no-tabs": "off",
			"no-console": "error",
			"@typescript-eslint/no-unused-vars": [
				"error",
				{
					argsIgnorePattern: "^_",
					varsIgnorePattern: "^_",
					caughtErrorsIgnorePattern: "^_",
				},
			],
			"@typescript-eslint/no-unused-expressions": [
				"error",
				{ allowTernary: true },
			],
			"@typescript-eslint/explicit-function-return-type": [
				"warn",
				{ allowExpressions: true },
			],
		},
	}
);
