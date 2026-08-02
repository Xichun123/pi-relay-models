import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function parseJsonRecord(content: string, path: string): Record<string, unknown> {
	const value: unknown = JSON.parse(content);
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${path} must contain a JSON object`);
	}
	return value as Record<string, unknown>;
}

async function writeJsonRecord(path: string, value: Record<string, unknown>): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		await writeFile(tempPath, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
		await rename(tempPath, path);
		await chmod(path, 0o600);
	} catch (error) {
		await rm(tempPath, { force: true });
		throw error;
	}
}

/** Remove one provider entry while preserving unrelated persisted state. */
export async function deleteJsonRecordKey(path: string, key: string): Promise<boolean> {
	let content: string;
	try {
		content = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}

	const value = parseJsonRecord(content, path);
	if (!Object.hasOwn(value, key)) return false;
	delete value[key];
	await writeJsonRecord(path, value);
	return true;
}
