import type { APIRoute } from "astro";
import { type EveEvent, eveFetch } from "../../../lib/eve";

const SESSION_ID = /^wrun_[A-Z0-9]+$/;
const SETTLED = new Set([
	"session.waiting",
	"session.failed",
	"session.completed",
]);

function redact(event: EveEvent): EveEvent {
	if (event.type !== "message.received") return event;
	const data = structuredClone(event.data ?? {});
	if (Array.isArray(data.parts)) {
		data.parts = data.parts.map((part) =>
			typeof part === "object" &&
			part &&
			"type" in part &&
			(part as { type?: unknown }).type === "file"
				? {
						...(part as Record<string, unknown>),
						url: "[inline attachment redacted]",
					}
				: part,
		);
	}
	return { ...event, data };
}

export const GET: APIRoute = async ({ params }) => {
	const id = params.id ?? "";
	if (!SESSION_ID.test(id))
		return Response.json({ error: "Invalid eve session ID" }, { status: 400 });
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 1_500);
	const events: EveEvent[] = [];
	let pending = "";
	try {
		const upstream = await eveFetch(
			`/eve/v1/session/${id}/stream?startIndex=0`,
			{
				signal: controller.signal,
			},
		);
		if (!upstream.ok)
			return new Response(await upstream.text(), {
				status: upstream.status,
				headers: { "content-type": "application/json" },
			});
		const reader = upstream.body?.getReader();
		const decoder = new TextDecoder();
		while (reader) {
			const { done, value } = await reader.read();
			if (done) break;
			pending += decoder.decode(value, { stream: true });
			const lines = pending.split("\n");
			pending = lines.pop() ?? "";
			for (const line of lines) {
				if (!line) continue;
				try {
					const event = redact(JSON.parse(line) as EveEvent);
					events.push(event);
					if (SETTLED.has(event.type)) {
						await reader.cancel();
						return Response.json(
							{ sessionId: id, events },
							{ headers: { "cache-control": "no-store" } },
						);
					}
				} catch {
					// Ignore malformed or partial durable-stream lines.
				}
			}
		}
	} catch (error) {
		if (!(error instanceof Error && error.name === "AbortError")) throw error;
	} finally {
		clearTimeout(timer);
	}
	return Response.json(
		{ sessionId: id, events },
		{ headers: { "cache-control": "no-store" } },
	);
};

export const DELETE: APIRoute = async ({ params }) => {
	const id = params.id ?? "";
	if (!SESSION_ID.test(id))
		return Response.json({ error: "Invalid eve session ID" }, { status: 400 });
	const upstream = await eveFetch(`/eve/v1/session/${id}/cancel`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ tasks: true }),
	});
	return new Response(upstream.body, {
		status: upstream.status,
		headers: {
			"content-type":
				upstream.headers.get("content-type") ?? "application/json",
		},
	});
};
