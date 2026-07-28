import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("uses a root extension entry so Pi shows only the package name", async () => {
	const packageJson = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8")) as {
		pi?: { extensions?: string[] };
	};
	assert.deepEqual(
		packageJson.pi?.extensions,
		["./extensions/index.ts"],
		"nested index entries are displayed by Pi as package-name:directory-name",
	);
});
