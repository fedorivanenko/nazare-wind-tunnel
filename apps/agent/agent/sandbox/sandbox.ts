import { defineSandbox } from "eve/sandbox";
import { vercel } from "eve/sandbox/vercel";

const pnpmCacheDrive = process.env.WIND_TUNNEL_PNPM_CACHE_DRIVE?.trim();

export default defineSandbox({
	backend: vercel({
		networkPolicy: { allow: ["registry.npmjs.org"] },
		resources: { vcpus: 2 },
		...(pnpmCacheDrive
			? {
					sessionCreateOptions: () => ({
						mounts: {
							"/workspace/.pnpm-store": {
								drive: pnpmCacheDrive,
								mode: "read-write" as const,
							},
						},
					}),
				}
			: {}),
	}),
	revalidationKey: () => "nazare-wind-tunnel-eve-v1-pnpm-10.17.1",
	async bootstrap({ use }) {
		const sandbox = await use();
		const result = await sandbox.run({
			command: "sudo npm install --global pnpm@10.17.1",
		});
		if (result.exitCode !== 0)
			throw new Error(
				`Could not install pnpm 10.17.1: ${result.stderr || result.stdout}`,
			);
	},
	async onSession({ use }) {
		await use({ networkPolicy: { allow: ["registry.npmjs.org"] } });
	},
});
