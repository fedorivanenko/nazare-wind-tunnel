import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

function key(node: string, packageManager: string, lockfile: string) {
	return createHash("sha256")
		.update(
			JSON.stringify({
				node,
				packageManager,
				lockfileSha256: createHash("sha256").update(lockfile).digest("hex"),
			}),
		)
		.digest("hex");
}

test("prepared dependency key changes with runtime or lockfile", () => {
	const a = key("24", "pnpm@10.17.1", "lock-a");
	assert.equal(a, key("24", "pnpm@10.17.1", "lock-a"));
	assert.notEqual(a, key("24", "pnpm@10.17.1", "lock-b"));
	assert.notEqual(a, key("24", "pnpm@10.18.0", "lock-a"));
	assert.notEqual(a, key("22", "pnpm@10.17.1", "lock-a"));
});
