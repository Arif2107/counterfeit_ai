export function maxImageBytes(env: Env): number {
	const n = Number(env.MAX_IMAGE_BYTES);
	return Number.isFinite(n) && n > 0 ? n : 5 * 1024 * 1024;
}