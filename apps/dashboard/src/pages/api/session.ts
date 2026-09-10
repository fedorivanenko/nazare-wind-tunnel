import type { APIRoute } from "astro";
import { COOKIE, equal, sessionValue } from "../../middleware";

export const POST: APIRoute = async ({ request, cookies }) => {
	const expected = process.env.DASHBOARD_ACCESS_TOKEN ?? "";
	if (!expected) return new Response(null, { status: 204 });
	const form = await request.formData();
	const supplied = String(form.get("token") ?? "");
	if (!equal(supplied, expected))
		return new Response("Unauthorized", { status: 401 });
	cookies.set(COOKIE, sessionValue(), {
		httpOnly: true,
		secure: true,
		sameSite: "strict",
		path: "/",
		maxAge: 60 * 60 * 24 * 30,
	});
	return new Response(null, { status: 204 });
};

export const DELETE: APIRoute = async ({ cookies }) => {
	cookies.delete(COOKIE, { path: "/" });
	return new Response(null, { status: 204 });
};
