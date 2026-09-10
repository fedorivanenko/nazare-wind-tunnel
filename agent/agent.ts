import { defineAgent } from "eve";

export default defineAgent({
	model: "openai/gpt-oss-120b",
	reasoning: "low",
	defaultTools: false,
	limits: {
		maxInputTokensPerSession: 50_000,
		maxOutputTokensPerSession: 6_000,
		maxTokenCostUsdPerSession: 0.15,
		sessionTimeoutMs: 2 * 60 * 1_000,
	},
});
