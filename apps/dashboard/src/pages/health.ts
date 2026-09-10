import type { APIRoute } from "astro";

export const GET: APIRoute = async () =>
	Response.json({
		ok: true,
		service: "nazare-wind-tunnel-dashboard",
		runtime: "eve",
		version: 2,
	});
