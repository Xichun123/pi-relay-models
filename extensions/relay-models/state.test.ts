import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deleteJsonRecordKey } from "./state.ts";

test("deletes one provider key while preserving unrelated JSON state", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-relay-models-"));
	const path = join(directory, "nested", "state.json");
	await mkdir(join(directory, "nested"));
	await writeFile(
		path,
		JSON.stringify({ "relay-remove": { secret: "not-returned" }, "relay-keep": { value: 42 } }, null, 2),
		{ mode: 0o644 },
	);

	assert.equal(await deleteJsonRecordKey(path, "relay-remove"), true);
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { "relay-keep": { value: 42 } });
	assert.equal((await stat(path)).mode & 0o777, 0o600);
	assert.equal(await deleteJsonRecordKey(path, "relay-remove"), false);
});

test("treats a missing state file as already clean", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-relay-models-"));
	assert.equal(await deleteJsonRecordKey(join(directory, "missing.json"), "relay-remove"), false);
});

test("refuses to rewrite malformed or non-object state", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-relay-models-"));
	const malformedPath = join(directory, "malformed.json");
	const arrayPath = join(directory, "array.json");
	await writeFile(malformedPath, "{");
	await writeFile(arrayPath, "[]");

	await assert.rejects(deleteJsonRecordKey(malformedPath, "relay-remove"), SyntaxError);
	await assert.rejects(deleteJsonRecordKey(arrayPath, "relay-remove"), /must contain a JSON object/u);
});
