export const REPOSITORY_ROOT = "/workspace/repo";
const MAX_TEXT_BYTES = 200_000;

export function shellQuote(value: string) {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export function bounded(text: string, maxBytes = MAX_TEXT_BYTES) {
	const bytes = Buffer.from(text);
	return bytes.byteLength <= maxBytes
		? text
		: `${bytes.subarray(0, maxBytes).toString("utf8")}\n[truncated at ${maxBytes} bytes]`;
}
