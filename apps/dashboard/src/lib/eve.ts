const EVE_URL = (process.env.EVE_WIND_TUNNEL_URL ?? "").replace(/\/$/, "");
const EVE_TOKEN = process.env.WIND_TUNNEL_TOKEN ?? "";

function configured() {
	if (!EVE_URL) throw new Error("EVE_WIND_TUNNEL_URL is required");
	if (!EVE_TOKEN) throw new Error("WIND_TUNNEL_TOKEN is required");
}

export async function eveFetch(path: string, init: RequestInit = {}) {
	configured();
	const headers = new Headers(init.headers);
	headers.set("authorization", `Bearer ${EVE_TOKEN}`);
	return fetch(`${EVE_URL}${path}`, { ...init, headers, redirect: "error" });
}

export async function eveJson<T>(
	path: string,
	init: RequestInit = {},
): Promise<T> {
	const response = await eveFetch(path, init);
	if (!response.ok)
		throw new Error(`eve ${response.status}: ${await response.text()}`);
	return response.json() as Promise<T>;
}

export type EveEvent = {
	type: string;
	meta?: { at?: string; id?: string };
	data?: Record<string, unknown>;
};
