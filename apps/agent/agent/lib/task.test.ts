import assert from "node:assert/strict";
import test from "node:test";
import { parseRunTask } from "./task";

test("applies optional task defaults", () => {
	assert.deepEqual(parseRunTask({ agent: { prompt: "Make focused change" } }), {
		prepare: [],
		agent: { prompt: "Make focused change" },
		verify: [],
	});
});

test("rejects unsafe task budgets", () => {
	assert.throws(() =>
		parseRunTask({
			agent: {
				prompt: "Make focused change",
				maxToolCalls: 65,
			},
		}),
	);
});
