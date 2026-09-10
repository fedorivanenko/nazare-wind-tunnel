import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const repository = "/workspace/repo";
const read = (file: string) => readFile(`${repository}/${file}`, "utf8");
const [hero, root, capabilitySource, resend] = await Promise.all([
	read("app/nazare/carcass/sections/Hero.tsx"),
	read("app/root.tsx"),
	read("app/nazare/capabilities/collect-email-subscribers.ts"),
	read("app/nazare/connectors/resend.server.ts"),
]);
const registry = await import(`${repository}/app/nazare/registry/index.ts`);
const capability = registry.getCapability(
	"capability.collect-email-subscribers",
);
assert.ok(capability, "collect-email-subscribers capability must exist");
assert.deepEqual(
	capability.policies.map((policy: { id: string }) => policy.id),
	["valid-email", "marketing-consent"],
	"capability must preserve valid-email and add marketing-consent policy",
);
assert.deepEqual(
	capability.evidence.map((evidence: { id: string }) => evidence.id),
	["contact-created"],
	"contact-created evidence contract must remain unchanged",
);
const binding = capability.bindings.find(
	(item: { id: string }) => item.id === "binding.route.root.hero-email-signup",
);
assert.ok(binding, "Hero route binding must exist");
assert.deepEqual(
	binding.inputs.map((input: { name: string }) => input.name),
	["email", "marketingConsent"],
	"binding must prove email and marketingConsent inputs",
);
assert.match(
	binding.invocation,
	/execute\([^)]*email[^)]*marketingConsent[^)]*context\.env/,
	"binding invocation must carry consent into capability",
);
assert.match(hero, /type=["']checkbox["']/, "Hero must render checkbox");
assert.match(
	hero,
	/name=["']marketingConsent["']/,
	"checkbox must be named marketingConsent",
);
assert.match(hero, /required/, "marketing consent checkbox must be required");
assert.match(
	root,
	/formData\.get\(["']marketingConsent["']\)/,
	"route action must read marketingConsent",
);
assert.match(
	root,
	/execute\([^)]*email[^)]*marketingConsent[^)]*context\.env/,
	"route action must pass consent into capability",
);
const rejectIndex = capabilitySource.search(
	/marketing-consent|marketingConsent/,
);
const providerIndex = capabilitySource.indexOf("await createResendContact");
assert.ok(
	rejectIndex >= 0 && providerIndex > rejectIndex,
	"capability must reject missing consent before provider call",
);
assert.equal(
	createHash("sha256").update(resend).digest("hex"),
	"47d5015cfa8301fcea9bccdbf9bd78e15b8d23c1d941efa7b5f6346532b0225a",
	"Resend provider adapter and payload must remain unchanged",
);
console.log("Marketing-consent task verification passed.");
