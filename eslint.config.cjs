// Flat config (the only format ESLint 9+ reads).
//
// Deliberately CommonJS. The pre-commit hook installs eslint and its companion
// packages into pre-commit's own isolated node environment rather than a
// node_modules/ beside this file, and Node's ESM resolver will not look there —
// an eslint.config.mjs doing `import js from "@eslint/js"` dies with
// ERR_MODULE_NOT_FOUND. require() does find them, so .cjs is what keeps this
// repo free of a package.json and a local npm install.
//
// The tree holds two kinds of JavaScript with disjoint globals, so each gets its
// own block rather than one permissive environment that would let a browser
// global slip into a deploy script unnoticed.

const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
	{
		ignores: [
			// Vendored third-party bundle, kept byte-identical to upstream.
			"public/js/papaparse.min.js",
			// Build output from scripts/fetch_icons.mjs.
			"public/img/icons/**",
			".cache/**",
		],
	},
	js.configs.recommended,
	{
		// Loaded with a plain <script> tag, not as a module.
		files: ["public/js/**/*.js"],
		languageOptions: {
			ecmaVersion: "latest",
			sourceType: "script",
			globals: {
				...globals.browser,
				// Defined by the vendored papaparse.min.js loaded before main.js.
				Papa: "readonly",
			},
		},
	},
	{
		files: ["scripts/**/*.mjs"],
		languageOptions: {
			ecmaVersion: "latest",
			sourceType: "module",
			globals: globals.node,
		},
	},
	{
		files: ["**/*.cjs"],
		languageOptions: {
			ecmaVersion: "latest",
			sourceType: "commonjs",
			globals: globals.node,
		},
	},
];
