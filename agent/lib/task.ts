import { z } from "zod";

export const runTaskSchema = z.object({
	prepare: z.array(z.string().min(1)).default([]),
	agent: z.object({
		prompt: z.string().min(1).max(50_000),
		timeoutMs: z
			.number()
			.int()
			.positive()
			.max(10 * 60_000)
			.optional(),
		maxToolCalls: z.number().int().min(1).max(64).optional(),
	}),
	verify: z.array(z.string().min(1)).default([]),
});

export type RunTask = z.infer<typeof runTaskSchema>;

export function parseRunTask(value: unknown): RunTask {
	return runTaskSchema.parse(value);
}
