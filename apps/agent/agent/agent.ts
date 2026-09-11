import { defineAgent } from "eve";

export default defineAgent({
	model: "openai/gpt-oss-120b",
	reasoning: "low",
	defaultTools: false,
	limits: {
		maxInputTokensPerSession: false,
		maxOutputTokensPerSession: false,
		maxTokenCostUsdPerSession: false,
		sessionTimeoutMs: false,
	},
});
