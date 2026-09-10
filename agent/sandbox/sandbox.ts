import { defineSandbox } from "eve/sandbox";
import { vercel } from "eve/sandbox/vercel";

const baseSnapshotId = process.env.WIND_TUNNEL_BASE_SNAPSHOT_ID?.trim() || null;
const sandboxSource = baseSnapshotId
	? ({ type: "snapshot", snapshotId: baseSnapshotId } as const)
	: undefined;

export default defineSandbox({
	backend: vercel({
		...(sandboxSource ? { source: sandboxSource } : {}),
		networkPolicy: { allow: ["registry.npmjs.org"] },
		resources: { vcpus: 2 },
	}),
	revalidationKey: () =>
		[
			"nazare-wind-tunnel-eve-v2",
			"pnpm-10.17.1",
			baseSnapshotId ? `snapshot-${baseSnapshotId}` : "default-image",
		].join(":"),
	async bootstrap({ use }) {
		const sandbox = await use();
		const result = await sandbox.run({
			command:
				"command -v pnpm >/dev/null 2>&1 && pnpm --version | grep -qx '10.17.1' || sudo npm install --global pnpm@10.17.1",
		});
		if (result.exitCode !== 0)
			throw new Error(
				`Could not prepare pnpm 10.17.1: ${result.stderr || result.stdout}`,
			);
	},
	async onSession({ use }) {
		await use({ networkPolicy: { allow: ["registry.npmjs.org"] } });
	},
});
