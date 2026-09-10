import type { APIRoute } from "astro";
import { eveFetch } from "../../../lib/eve";

export const GET: APIRoute = async ({ request, params }) => {
	const suffix = params.path ? `/${params.path}` : "";
	const incoming = new URL(request.url);
	const upstream = await eveFetch(`/api/runs${suffix}${incoming.search}`);
	return new Response(upstream.body, {
		status: upstream.status,
		headers: {
			"content-type":
				upstream.headers.get("content-type") ?? "application/json",
			"cache-control": "no-store",
		},
	});
};
