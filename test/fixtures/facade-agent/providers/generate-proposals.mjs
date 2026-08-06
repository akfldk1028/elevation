import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import sharp from "sharp";

const root = dirname(fileURLToPath(import.meta.url));
const designs = [
	{
		path: join(root, "openai", "proposal.png"), wall: "#8b3f2f", mortar: "#b87762", trim: "#dfd2bb",
		bays: 8, windowWidth: 92, windowHeight: 145, bayGap: 54, offset: 0,
	},
	{
		path: join(root, "byteplus", "proposal.png"), wall: "#a65b3d", mortar: "#d18b69", trim: "#e7c99f",
		bays: 10, windowWidth: 66, windowHeight: 165, bayGap: 46, offset: 23,
	},
	{
		path: join(root, "alibaba", "proposal.png"), wall: "#71382e", mortar: "#a96350", trim: "#d9b995",
		bays: 6, windowWidth: 126, windowHeight: 132, bayGap: 70, offset: 11,
	},
];

function facadeSvg(design) {
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
	return `<svg xmlns="http://www.w3.org/2000/svg" width="1536" height="1536" viewBox="0 0 1536 1536">
	<defs><pattern id="brick" width="56" height="28" patternUnits="userSpaceOnUse"><rect width="56" height="28" fill="${design.wall}"/><path d="M0 0H56M0 28H56M28 0V14M0 14H56M14 14V28M42 14V28" stroke="${design.mortar}" stroke-width="3" opacity=".7"/></pattern></defs>
	<rect width="1536" height="1536" fill="#ece8df"/>
	<rect x="124" y="1320" width="1288" height="28" fill="#77736c"/>
	<rect x="${facadeX}" y="${facadeY}" width="${facadeWidth}" height="1090" fill="url(#brick)" stroke="#4c332c" stroke-width="8"/>
	<rect x="${facadeX - 18}" y="${facadeY - 24}" width="${facadeWidth + 36}" height="34" fill="${design.trim}"/>
	${[1, 2, 3, 4].map((floor) => `<rect x="${facadeX}" y="${facadeY + floor * floorHeight - 9}" width="${facadeWidth}" height="18" fill="${design.trim}" opacity=".72"/>`).join("")}
	${windows.join("")}
	<rect x="${facadeX + 475}" y="${facadeY + 5 * floorHeight - 182}" width="250" height="182" fill="#40342e" stroke="${design.trim}" stroke-width="16"/>
	</svg>`;
}

for (const design of designs) {
	await mkdir(dirname(design.path), { recursive: true });
	await sharp(Buffer.from(facadeSvg(design))).png({ compressionLevel: 9 }).toFile(design.path);
}
