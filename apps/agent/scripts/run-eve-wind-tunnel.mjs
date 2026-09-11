import { readFile, writeFile } from "node:fs/promises";
import { Client } from "eve/client";

function required(name) {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}
const host = required("EVE_WIND_TUNNEL_URL").replace(/\/$/, "");
const token = required("WIND_TUNNEL_TOKEN");
const repository = required("SUBJECT_REPO");
const sourceSha = required("SUBJECT_SHA");
const experiment = required("EXPERIMENT");
const archivePath = required("SUBJECT_ARCHIVE");
const timeoutMs = Number(process.env.EVE_RUN_TIMEOUT_MS ?? 180_000);
const bytes = await readFile(archivePath);
const client = new Client({ host, auth: { bearer: token }, redirect: "error" });
await client.health();
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), timeoutMs);
let session;
try {
	const created = await client.sessions.create({
		operationId: `${repository}:${sourceSha}:${experiment}:${process.env.GITHUB_RUN_ID ?? Date.now()}`,
		message: [
			{
				type: "text",
				text: `Implement Wind Tunnel experiment ${experiment} for ${repository} at exact source SHA ${sourceSha}. First call prepare_subject with this experiment path. After implementation call finish_run.`,
			},
			{
				type: "file",
				data: `data:application/gzip;base64,${bytes.toString("base64")}`,
				mediaType: "application/gzip",
				filename: "source.tar.gz",
			},
		],
		clientContext: {
			repository,
			sourceSha,
			experiment,
			runtime: "eve@0.52.5",
			sandbox: "vercel",
		},
		signal: controller.signal,
	});
	session = created.session;
	const result = await created.response.result();
	const failedEvent = result.events.find(
		(event) => event.type === "turn.failed" || event.type === "session.failed",
	);
	const status = failedEvent ? "failed" : result.status;
	const output = {
		sessionId: result.sessionId,
		status,
		message: result.message ?? null,
		eventCount: result.events.length,
		error: failedEvent && "data" in failedEvent ? failedEvent.data : null,
	};
	const sanitizedEvents = JSON.parse(
		JSON.stringify(result.events, (_key, value) =>
			typeof value === "string" && value.startsWith("data:")
				? "[inline attachment redacted]"
				: value,
		),
	);
	await writeFile(
		process.env.EVE_RESULT_PATH ?? "eve-result.json",
		JSON.stringify(output, null, 2),
	);
	await writeFile(
		process.env.EVE_EVENTS_PATH ?? "eve-events.json",
		JSON.stringify(sanitizedEvents, null, 2),
	);
	process.stdout.write(`${JSON.stringify(output)}\n`);
	if (status === "failed") process.exitCode = 1;
} finally {
	clearTimeout(timeout);
	if (controller.signal.aborted && session)
		await session.cancel({ tasks: true }).catch(() => {});
}
