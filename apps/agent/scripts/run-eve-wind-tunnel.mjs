import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

function required(name) {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}

async function responseJson(response) {
	const body = await response.text();
	if (!response.ok)
		throw new Error(`Wind Tunnel API ${response.status}: ${body}`);
	return JSON.parse(body);
}

const host = required("EVE_WIND_TUNNEL_URL").replace(/\/$/, "");
const token = required("WIND_TUNNEL_TOKEN");
const repository = required("SUBJECT_REPO");
const sourceSha = required("SUBJECT_SHA");
const taskPath = required("EXPERIMENT");
const timeoutMs = Number(process.env.EVE_RUN_TIMEOUT_MS ?? 10 * 60_000);
const operationId =
	process.env.WIND_TUNNEL_OPERATION_ID ??
	`${repository}:${sourceSha}:${randomUUID()}`;
const task = JSON.parse(await readFile(taskPath, "utf8"));
const headers = {
	authorization: `Bearer ${token}`,
	"content-type": "application/json",
};
const signal = AbortSignal.timeout(timeoutMs);

const accepted = await responseJson(
	await fetch(`${host}/api/runs`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			operationId,
			workspaceId: repository,
			repository,
			sourceSha,
			task,
			trigger: { provider: "local-client" },
		}),
		signal,
	}),
);

let detail;
while (true) {
	detail = await responseJson(
		await fetch(`${host}/api/runs/${accepted.runId}`, { headers, signal }),
	);
	if (["completed", "failed", "cancelled"].includes(detail.run.status)) break;
	await new Promise((resolve) => setTimeout(resolve, 2_000));
}

const output = {
	runId: accepted.runId,
	sessionId: accepted.sessionId,
	status: detail.run.status,
	result: detail.run.result,
	error: detail.run.error,
};
await writeFile(
	process.env.EVE_RESULT_PATH ?? "eve-result.json",
	JSON.stringify(output, null, 2),
);
await writeFile(
	process.env.EVE_EVENTS_PATH ?? "eve-events.json",
	JSON.stringify(detail.events, null, 2),
);
process.stdout.write(`${JSON.stringify(output)}\n`);
if (detail.run.status !== "completed" || detail.run.result?.passed !== true)
	process.exitCode = 1;
