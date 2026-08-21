import * as THREE from "three";

// ---------------- procedural canvas textures ----------------
//
// HAZARD: the bump passes of these generators re-step their own RNG in
// lockstep with the color passes (see brickMaps' r2();r2();r2(); calls).
// The function bodies are moved VERBATIM from the original monolith; any
// change to an RNG call count silently changes every default render.

export function canvasTexture(size, draw, srgb) {
	const canvas = document.createElement("canvas");
	canvas.width = size; canvas.height = size;
	draw(canvas.getContext("2d"), size);
	const tex = new THREE.CanvasTexture(canvas);
	tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
	if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
	return tex;
}

export function mulberry32(seed) {
	let a = seed >>> 0;
	return function () {
		a |= 0; a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function speckle(ctx, size, count, alpha, rand) {
	for (let i = 0; i < count; i++) {
		const l = Math.floor(rand() * 255);
		ctx.fillStyle = "rgba(" + l + "," + l + "," + l + "," + alpha + ")";
		ctx.fillRect(rand() * size, rand() * size, 1 + rand() * 2, 1 + rand() * 2);
	}
}

// Brick: 1 tile = 1m x 1m. 12 courses, 4 bricks per course, running bond.
// Optional base hue/sat/lit override the brick body color (defaults keep the
// original texture byte-identical).
export function brickMaps(baseHue, baseSat, baseLit, mortar) {
	if (baseHue === undefined) baseHue = 14;
	if (baseSat === undefined) baseSat = 42;
	if (baseLit === undefined) baseLit = 34;
	if (mortar === undefined) mortar = "#b3a494";
	const rand = mulberry32(7);
	const courses = 12, perRow = 4, size = 1024;
	const ch = size / courses, bw = size / perRow, joint = Math.round(size * 0.011);
	const color = canvasTexture(size, function (ctx) {
		ctx.fillStyle = mortar; ctx.fillRect(0, 0, size, size);
		for (let r = 0; r < courses; r++) {
			const offset = (r % 2) * (bw / 2);
			for (let b = -1; b < perRow + 1; b++) {
				const hue = baseHue + (rand() - 0.5) * 10;
				const sat = baseSat + (rand() - 0.5) * 12;
				const lit = baseLit + (rand() - 0.5) * 13;
				ctx.fillStyle = "hsl(" + hue + "," + sat + "%," + lit + "%)";
				ctx.fillRect(b * bw + offset + joint / 2, r * ch + joint / 2, bw - joint, ch - joint);
				// slight tonal patch inside the brick
				ctx.fillStyle = "hsla(" + (hue + 8) + "," + sat + "%," + (lit + 6) + "%,0.35)";
				ctx.fillRect(b * bw + offset + joint / 2 + rand() * bw * 0.4, r * ch + joint / 2, bw * 0.3, ch - joint);
			}
		}
		speckle(ctx, size, 9000, 0.05, rand);
	}, true);
	const bump = canvasTexture(size, function (ctx) {
		ctx.fillStyle = "#5a5a5a"; ctx.fillRect(0, 0, size, size); // mortar recessed
		const r2 = mulberry32(7);
		for (let r = 0; r < courses; r++) {
			const offset = (r % 2) * (bw / 2);
			for (let b = -1; b < perRow + 1; b++) {
				r2(); r2(); r2(); // keep in step with color pass
				const l = 175 + Math.floor((r2() - 0.5) * 40); r2();
				ctx.fillStyle = "rgb(" + l + "," + l + "," + l + ")";
				ctx.fillRect(b * bw + offset + joint / 2, r * ch + joint / 2, bw - joint, ch - joint);
			}
		}
		speckle(ctx, size, 6000, 0.10, r2);
	}, false);
	return { color: color, bump: bump };
}

// Light matte stone / in-situ concrete for the mass. 1 tile = 4m.
// Optional mottleAlpha strengthens the tonal patches (default keeps the
// original texture byte-identical).
export function stoneMaps(base, mottleAlpha) {
	if (mottleAlpha === undefined) mottleAlpha = 0.12;
	const rand = mulberry32(31);
	const color = canvasTexture(1024, function (ctx, size) {
		ctx.fillStyle = base; ctx.fillRect(0, 0, size, size);
		for (let i = 0; i < 320; i++) {
			const g = 175 + Math.floor(rand() * 65);
			ctx.fillStyle = "rgba(" + g + "," + (g - 6) + "," + (g - 14) + "," + mottleAlpha + ")";
			const w = 40 + rand() * 220, h = 20 + rand() * 120;
			ctx.fillRect(rand() * size - w / 2, rand() * size - h / 2, w, h);
		}
		speckle(ctx, size, 16000, 0.035, rand);
	}, true);
	const bump = canvasTexture(512, function (ctx, size) {
		ctx.fillStyle = "#808080"; ctx.fillRect(0, 0, size, size);
		speckle(ctx, size, 14000, 0.10, mulberry32(97));
	}, false);
	return { color: color, bump: bump };
}

// Smooth precast for bands / sills / lintels / cornices / spandrels. 1 tile = 2m.
// Optional joints draws recessed panel-joint lines along the tile border, so a
// wall-field use of the same texture reads as panelized precast (default keeps
// the trim texture byte-identical).
export function precastMaps(joints) {
	const rand = mulberry32(53);
	const color = canvasTexture(512, function (ctx, size) {
		ctx.fillStyle = joints ? "#dcd5c6" : "#e3ddd0"; ctx.fillRect(0, 0, size, size);
		for (let i = 0; i < 120; i++) {
			const g = 205 + Math.floor(rand() * 35);
			ctx.fillStyle = "rgba(" + g + "," + (g - 4) + "," + (g - 12) + ",0.08)";
			ctx.fillRect(rand() * size, rand() * size, 30 + rand() * 90, 30 + rand() * 90);
		}
		speckle(ctx, size, 6000, 0.03, rand);
		if (joints) {
			ctx.strokeStyle = "rgba(74,66,54,0.8)";
			ctx.lineWidth = 8;
			ctx.strokeRect(4, 4, size - 8, size - 8);
		}
	}, true);
	return { color: color };
}

// Standing-seam zinc cladding. 1 tile = 3m -> 7 panels, so a raised seam every
// ~0.43m. Cool blue-grey (#5a6068 family), faint vertical mill streaks and a
// slight panel-to-panel value shift so the field does not read as one flat sheet.
export function zincMaps() {
	const rand = mulberry32(41);
	const size = 1024, panels = 7, pw = size / panels;
	const color = canvasTexture(size, function (ctx) {
		for (let p = 0; p < panels; p++) {
			const lit = 38 + (rand() - 0.5) * 11; // panel-to-panel value variation
			ctx.fillStyle = "hsl(216,8%," + lit + "%)";
			ctx.fillRect(Math.floor(p * pw), 0, Math.ceil(pw), size);
			// faint full-height mill streaks inside the panel (anisotropic feel)
			for (let i = 0; i < 18; i++) {
				const l = Math.floor((lit + (rand() - 0.5) * 9) * 2.55);
				ctx.fillStyle = "rgba(" + l + "," + (l + 3) + "," + (l + 8) + ",0.22)";
				ctx.fillRect(p * pw + rand() * (pw - 4), 0, 1 + rand() * 3, size);
			}
		}
		// seam shading: shadow line against a lit ridge at every panel edge
		for (let p = 0; p < panels; p++) {
			const x = Math.round(p * pw);
			ctx.fillStyle = "rgba(18,22,28,0.7)";
			ctx.fillRect(x, 0, 4, size);
			ctx.fillStyle = "rgba(214,224,236,0.5)";
			ctx.fillRect(x + 4, 0, 3, size);
		}
		speckle(ctx, size, 2500, 0.03, rand);
	}, true);
	const bump = canvasTexture(size, function (ctx) {
		const r2 = mulberry32(59);
		for (let p = 0; p < panels; p++) {
			// slight per-panel oil-canning level
			const l = 122 + Math.floor((r2() - 0.5) * 14);
			ctx.fillStyle = "rgb(" + l + "," + l + "," + l + ")";
			ctx.fillRect(Math.floor(p * pw), 0, Math.ceil(pw), size);
		}
		for (let p = 0; p < panels; p++) {
			// thin raised standing seam at the panel edge
			const x = Math.round(p * pw);
			ctx.fillStyle = "#6a6a6a"; ctx.fillRect(x, 0, 2, size);
			ctx.fillStyle = "#f0f0f0"; ctx.fillRect(x + 2, 0, 5, size);
			ctx.fillStyle = "#6a6a6a"; ctx.fillRect(x + 7, 0, 2, size);
		}
		speckle(ctx, size, 3000, 0.05, r2);
	}, false);
	return { color: color, bump: bump };
}

// Vertical timber slats. 1 tile = 1.44m -> 16 boards of 0.09m separated by
// thin dark gaps. Warm mid-brown (#8a6a48 family) with per-board hue/value
// jitter, full-height grain streaks and occasional butt joints so the field
// reads as natural boards rather than wallpaper.
export function woodMaps() {
	const rand = mulberry32(23);
	const size = 1024, boards = 16, bw = size / boards, gap = 6;
	const color = canvasTexture(size, function (ctx) {
		ctx.fillStyle = "#241a10"; ctx.fillRect(0, 0, size, size); // gap shadow
		for (let b = 0; b < boards; b++) {
			const hue = 28 + (rand() - 0.5) * 14; // per-board hue jitter
			const sat = 30 + (rand() - 0.5) * 10;
			const lit = 41 + (rand() - 0.5) * 14;
			const x0 = Math.round(b * bw) + gap / 2, w = Math.round(bw) - gap;
			ctx.fillStyle = "hsl(" + hue + "," + sat + "%," + lit + "%)";
			ctx.fillRect(x0, 0, w, size);
			// vertical grain streaks
			for (let i = 0; i < 26; i++) {
				const dl = (rand() - 0.5) * 14;
				ctx.fillStyle = "hsla(" + (hue - 4) + "," + (sat + 6) + "%," + (lit + dl) + "%,0.3)";
				ctx.fillRect(x0 + rand() * (w - 2), 0, 1 + rand() * 2, size);
			}
			// occasional butt joint so boards do not repeat as one full-height unit
			if (rand() < 0.6) {
				const y = size * (0.12 + rand() * 0.76);
				ctx.fillStyle = "rgba(30,20,10,0.7)";
				ctx.fillRect(x0, y, w, 3);
			}
		}
		speckle(ctx, size, 4000, 0.03, rand);
	}, true);
	const bump = canvasTexture(size, function (ctx) {
		ctx.fillStyle = "#404040"; ctx.fillRect(0, 0, size, size); // gaps recessed
		const r2 = mulberry32(87);
		for (let b = 0; b < boards; b++) {
			const l = 165 + Math.floor((r2() - 0.5) * 30);
			const x0 = Math.round(b * bw) + gap / 2, w = Math.round(bw) - gap;
			ctx.fillStyle = "rgb(" + l + "," + l + "," + l + ")";
			ctx.fillRect(x0, 0, w, size);
			for (let i = 0; i < 20; i++) {
				const g = l - 20 + Math.floor(r2() * 24);
				ctx.fillStyle = "rgba(" + g + "," + g + "," + g + ",0.5)";
				ctx.fillRect(x0 + r2() * (w - 2), 0, 1 + r2() * 2, size);
			}
		}
		speckle(ctx, size, 3000, 0.06, r2);
	}, false);
	return { color: color, bump: bump };
}

export function groundMaps() {
	const rand = mulberry32(11);
	const color = canvasTexture(1024, function (ctx, size) {
		ctx.fillStyle = "#98918a"; ctx.fillRect(0, 0, size, size);
		for (let i = 0; i < 700; i++) {
			const g = 110 + Math.floor(rand() * 80);
			ctx.fillStyle = "rgba(" + g + "," + (g - 4) + "," + (g - 10) + ",0.16)";
			const w = 30 + rand() * 260;
			ctx.fillRect(rand() * size - w / 2, rand() * size - w / 2, w, w * (0.3 + rand()));
		}
		speckle(ctx, size, 22000, 0.05, rand);
	}, true);
	return { color: color };
}
