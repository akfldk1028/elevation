import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const root = dirname(fileURLToPath(import.meta.url));

export const FACADE_PROPOSAL_FIXTURES = Object.freeze([
	{
		provider: "gpt-image-2", path: join(root, "openai", "proposal.png"), wall: "#8b3f2f", mortar: "#b87762", trim: "#dfd2bb",
		bays: 8, windowWidth: 92, windowHeight: 145, bayGap: 54, offset: 0,
		entranceDoorZone: { x: 475, width: 250, height: 182 },
	},
	{
		provider: "seedream-5-pro", path: join(root, "byteplus", "proposal.png"), wall: "#a65b3d", mortar: "#d18b69", trim: "#e7c99f",
		bays: 10, windowWidth: 66, windowHeight: 165, bayGap: 46, offset: 23,
		entranceDoorZone: { x: 475, width: 250, height: 182 },
	},
	{
		provider: "qwen-image-2", path: join(root, "alibaba", "proposal.png"), wall: "#71382e", mortar: "#a96350", trim: "#d9b995",
		bays: 6, windowWidth: 126, windowHeight: 132, bayGap: 70, offset: 11,
		entranceDoorZone: { x: 475, width: 250, height: 182 },
	},
]);

export const BYTEPLUS_GRAMMAR_FIXTURE = Object.freeze({
	system: "brick-punched-window-v1",
	surfaces: ["front", "right", "back", "left"],
	materials: ["brick", "precast", "window-frame", "glass"],
	corner_datum_m: 0,
	bay_width_m: 1.5,
	window_width_m: 0.9,
	window_height_m: 1.7,
	sill_height_m: 0.8,
	reveal_depth_m: 0.2,
	frame_width_m: 0.06,
	lintel_height_m: 0.15,
	sill_depth_m: 0.1,
	cladding_depth_m: 0.15,
	brick_module_m: [0.22, 0.07],
	confidence: 0.96,
	unresolved_surfaces: [],
});

export const BYTEPLUS_ROUTED_FACADE_FIXTURE = Object.freeze({
	grammar: BYTEPLUS_GRAMMAR_FIXTURE,
	proposalIntent: Object.freeze({
		entranceDoorZone: Object.freeze({ x: 475, width: 250, height: 182 }),
	}),
});

export function facadeFixtureSvg(design) {
	const facadeX = 168;
	const facadeY = 176;
	const facadeWidth = 1200;
	const floorHeight = 218;
	const windows = [];
	for (let floor = 0; floor < 5; floor += 1) {
		const total = design.bays * design.windowWidth + (design.bays - 1) * design.bayGap;
		const start = facadeX + (facadeWidth - total) / 2 + (floor % 2 ? design.offset : 0);
		for (let bay = 0; bay < design.bays; bay += 1) {
			const x = start + bay * (design.windowWidth + design.bayGap);
			if (x + design.windowWidth > facadeX + facadeWidth - 28) continue;
			const y = facadeY + 42 + floor * floorHeight;
			windows.push(`<rect x="${x}" y="${y}" width="${design.windowWidth}" height="${design.windowHeight}" rx="3" fill="#26333a" stroke="${design.trim}" stroke-width="14"/>`);
			windows.push(`<line x1="${x + design.windowWidth / 2}" y1="${y + 7}" x2="${x + design.windowWidth / 2}" y2="${y + design.windowHeight - 7}" stroke="#91a8b0" stroke-width="5"/>`);
		}
	}
	const door = design.entranceDoorZone;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="1536" height="1536" viewBox="0 0 1536 1536">
	<defs><pattern id="brick" width="56" height="28" patternUnits="userSpaceOnUse"><rect width="56" height="28" fill="${design.wall}"/><path d="M0 0H56M0 28H56M28 0V14M0 14H56M14 14V28M42 14V28" stroke="${design.mortar}" stroke-width="3" opacity=".7"/></pattern></defs>
	<rect width="1536" height="1536" fill="#ece8df"/>
	<rect x="0" y="0" width="1536" height="112" fill="#352f2b"/>
	<text x="768" y="48" text-anchor="middle" fill="#fff7e9" font-family="sans-serif" font-size="28" font-weight="700">SYNTHETIC OFFLINE FIXTURE</text>
	<text x="768" y="84" text-anchor="middle" fill="#f0cda4" font-family="sans-serif" font-size="20">NOT PROVIDER MODEL OUTPUT · NOT QUALITY EVIDENCE</text>
	<rect x="124" y="1320" width="1288" height="28" fill="#77736c"/>
	<rect x="${facadeX}" y="${facadeY}" width="${facadeWidth}" height="1090" fill="url(#brick)" stroke="#4c332c" stroke-width="8"/>
	<rect x="${facadeX - 18}" y="${facadeY - 24}" width="${facadeWidth + 36}" height="34" fill="${design.trim}"/>
	${[1, 2, 3, 4].map((floor) => `<rect x="${facadeX}" y="${facadeY + floor * floorHeight - 9}" width="${facadeWidth}" height="18" fill="${design.trim}" opacity=".72"/>`).join("")}
	${windows.join("")}
	<rect data-fixture-zone="entrance-door" x="${facadeX + door.x}" y="${facadeY + 5 * floorHeight - door.height}" width="${door.width}" height="${door.height}" fill="#40342e" stroke="${design.trim}" stroke-width="16"/>
	</svg>`;
}

export function facadeProposalFixture(provider) {
	const design = FACADE_PROPOSAL_FIXTURES.find((candidate) => candidate.provider === provider);
	if (!design) throw new Error(`Unknown facade proposal fixture: ${provider}`);
	return design;
}

export async function renderFacadeProposalFixture(provider) {
	const design = facadeProposalFixture(provider);
	return sharp(Buffer.from(facadeFixtureSvg(design))).png({ compressionLevel: 9 }).toBuffer();
}

export async function writeFacadeProposalFixtures() {
	for (const design of FACADE_PROPOSAL_FIXTURES) {
		await mkdir(dirname(design.path), { recursive: true });
		await sharp(Buffer.from(facadeFixtureSvg(design))).png({ compressionLevel: 9 }).toFile(design.path);
	}
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]).toLowerCase() : "";
if (invokedPath === resolve(fileURLToPath(import.meta.url)).toLowerCase()) await writeFacadeProposalFixtures();
