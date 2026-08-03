import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

const VIEW_ORDER = ["front", "right", "back", "left", "top", "axon"];

export async function prepareWanImages(plan) {
	const dir = join(plan.run_dir, "prepared", "views");
	await mkdir(dir, { recursive: true });
	const paths = [];
	for (const name of VIEW_ORDER) {
		const output = join(dir, `${name}.png`);
		await sharp(plan.source_views[name]).flatten({ background: "white" }).composite([
			{ input: { create: { width: 720, height: 36, channels: 3, background: "white" } }, top: 0, left: 0 },
			{ input: { create: { width: 720, height: 48, channels: 3, background: "white" } }, top: 672, left: 0 },
		]).png().toFile(output);
		paths.push(output);
	}
	const contact = join(dir, "contact-sheet.png");
	const tiles = await Promise.all(paths.map((path) => sharp(path).resize(480, 480, { fit: "contain", background: "white" }).png().toBuffer()));
	await sharp({ create: { width: 1440, height: 960, channels: 3, background: "white" } }).composite(tiles.map((input, index) => ({ input, left: (index % 3) * 480, top: Math.floor(index / 3) * 480 }))).png().toFile(contact);
	return [...paths, contact].map(async (path) => `data:image/png;base64,${(await readFile(path)).toString("base64")}`);
}

export async function resolvePreparedImages(plan) {
	return Promise.all(await prepareWanImages(plan));
}
