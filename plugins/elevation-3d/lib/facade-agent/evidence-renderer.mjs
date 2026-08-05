import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import sharp from "sharp";

export const FACADE_EVIDENCE_VIEW_NAMES = Object.freeze(["front", "right", "back", "left", "top", "axon", "opposite-axon"]);
export const FACADE_EVIDENCE_PASS_NAMES = Object.freeze(["color", "depth", "normal", "edge", "surface-id"]);
export const FACADE_EVIDENCE_SIZE = 1024;

let temporarySequence = 0;

function throwIfAborted(signal) {
	if (!signal?.aborted) return;
	if (typeof signal.throwIfAborted === "function") signal.throwIfAborted();
	throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function exactNames(value, names) {
	return Object.keys(value ?? {}).sort().join("|") === [...names].sort().join("|");
}

function vectorLength(value) {
	return Math.hypot(value[0], value[1], value[2]);
}

function normalize(value, label) {
	const length = vectorLength(value);
	if (!Number.isFinite(length) || length <= 1e-12) throw new Error(`${label} must have nonzero finite length`);
	return value.map((item) => item / length);
}

function subtract(left, right) {
	return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function dot(left, right) {
	return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function cross(left, right) {
	return [
		left[1] * right[2] - left[2] * right[1],
		left[2] * right[0] - left[0] * right[2],
		left[0] * right[1] - left[1] * right[0],
	];
}

function validVector(value) {
	return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
}

function validatedMesh(mesh) {
	const vertices = mesh?.vertices;
	const triangles = mesh?.triangles ?? mesh?.indices;
	if (!Array.isArray(vertices) || !vertices.length || !vertices.every(validVector)) throw new Error("mesh vertices must be finite xyz triples");
	if (!Array.isArray(triangles) || !triangles.length || !triangles.every((triangle) =>
		Array.isArray(triangle) && triangle.length === 3 && triangle.every((index) => Number.isInteger(index) && index >= 0 && index < vertices.length))) {
		throw new Error("mesh indices must be valid indexed triangles");
	}
	return { vertices, triangles };
}

function transformPoint(matrix, point) {
	return matrix.slice(0, 3).map((row) => row[0] * point[0] + row[1] * point[1] + row[2] * point[2] + row[3]);
}

function projectedVertices(vertices, camera) {
	const edge = FACADE_EVIDENCE_SIZE - 1;
	if (camera.projection === "orthographic") {
		const matrix = camera.view_matrix4;
		const bounds = camera.projected_bounds_m;
		if (!Array.isArray(matrix) || matrix.length !== 4 || !matrix.every((row) => Array.isArray(row) && row.length === 4 && row.every(Number.isFinite))) {
			throw new Error(`${camera.name} requires a finite view_matrix4`);
		}
		if (!Array.isArray(bounds) || bounds.length !== 2 || !bounds.every((point) => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite))) {
			throw new Error(`${camera.name} requires projected_bounds_m`);
		}
		const width = bounds[1][0] - bounds[0][0];
		const height = bounds[1][1] - bounds[0][1];
		if (width <= 0 || height <= 0) throw new Error(`${camera.name} projected bounds must have positive area`);
		const transformed = vertices.map((point) => transformPoint(matrix, point));
		const maxDepth = Math.max(...transformed.map((point) => point[2]));
		return transformed.map((point) => ({
			x: ((point[0] - bounds[0][0]) / width) * edge,
			y: ((bounds[1][1] - point[1]) / height) * edge,
			depth: maxDepth - point[2],
		}));
	}
	if (camera.projection !== "perspective" || !validVector(camera.position) || !validVector(camera.target) || !validVector(camera.up)
		|| !Number.isFinite(camera.fov_degrees) || camera.fov_degrees <= 0 || camera.fov_degrees >= 180) {
		throw new Error(`${camera.name} requires a valid perspective camera`);
	}
	const depth = normalize(subtract(camera.target, camera.position), `${camera.name} depth`);
	const right = normalize(cross(depth, camera.up), `${camera.name} right`);
	const up = normalize(cross(right, depth), `${camera.name} up`);
	const tangent = Math.tan(camera.fov_degrees * Math.PI / 360);
	return vertices.map((point) => {
		const relative = subtract(point, camera.position);
		const distance = dot(relative, depth);
		return {
			x: (dot(relative, right) / (distance * tangent) * 0.5 + 0.5) * edge,
			y: (0.5 - dot(relative, up) / (distance * tangent) * 0.5) * edge,
			depth: distance,
		};
	});
}

function signedEdge(a, b, x, y) {
	return (x - a.x) * (b.y - a.y) - (y - a.y) * (b.x - a.x);
}

function rasterize(mesh, camera, signal) {
	const { vertices, triangles } = mesh;
	const projected = projectedVertices(vertices, camera);
	const pixelCount = FACADE_EVIDENCE_SIZE * FACADE_EVIDENCE_SIZE;
	const depths = new Float64Array(pixelCount);
	depths.fill(Infinity);
	const triangleIds = new Int32Array(pixelCount);
	triangleIds.fill(-1);
	const normals = [];
	const light = normalize([0.35, -0.45, 0.82], "light");
	const colors = [];

	for (let triangleId = 0; triangleId < triangles.length; triangleId++) {
		if ((triangleId & 31) === 0) throwIfAborted(signal);
		const indices = triangles[triangleId];
		const worldA = vertices[indices[0]], worldB = vertices[indices[1]], worldC = vertices[indices[2]];
		const normal = normalize(cross(subtract(worldB, worldA), subtract(worldC, worldA)), `triangle ${triangleId} normal`);
		normals.push(normal);
		const intensity = 0.3 + 0.7 * Math.abs(dot(normal, light));
		colors.push([202, 198, 190].map((channel) => Math.round(channel * intensity)));
		const a = projected[indices[0]], b = projected[indices[1]], c = projected[indices[2]];
		if (![a, b, c].every((point) => Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.depth) && point.depth >= 0)) continue;
		const area = signedEdge(a, b, c.x, c.y);
		if (Math.abs(area) <= 1e-12) continue;
		const minX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
		const maxX = Math.min(FACADE_EVIDENCE_SIZE - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
		const minY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
		const maxY = Math.min(FACADE_EVIDENCE_SIZE - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
		for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
			const px = x + 0.5, py = y + 0.5;
			const weightA = signedEdge(b, c, px, py) / area;
			const weightB = signedEdge(c, a, px, py) / area;
			const weightC = 1 - weightA - weightB;
			if (weightA < -1e-10 || weightB < -1e-10 || weightC < -1e-10) continue;
			const pixelDepth = weightA * a.depth + weightB * b.depth + weightC * c.depth;
			const offset = y * FACADE_EVIDENCE_SIZE + x;
			if (pixelDepth < depths[offset] - 1e-10) {
				depths[offset] = pixelDepth;
				triangleIds[offset] = triangleId;
			}
		}
	}
	return { depths, triangleIds, normals, colors };
}

function visibleDepthRange(frame) {
	let minimum = Infinity, maximum = -Infinity;
	for (let index = 0; index < frame.depths.length; index++) if (frame.triangleIds[index] >= 0) {
		minimum = Math.min(minimum, frame.depths[index]);
		maximum = Math.max(maximum, frame.depths[index]);
	}
	return { minimum, maximum, span: Math.max(maximum - minimum, 1e-12) };
}

function passBuffer(frame, mode) {
	const output = Buffer.alloc(FACADE_EVIDENCE_SIZE * FACADE_EVIDENCE_SIZE * 3);
	const range = visibleDepthRange(frame);
	for (let index = 0; index < frame.triangleIds.length; index++) {
		const triangleId = frame.triangleIds[index];
		const offset = index * 3;
		if (mode === "edge") {
			output[offset] = output[offset + 1] = output[offset + 2] = 255;
			if (triangleId < 0) continue;
			const x = index % FACADE_EVIDENCE_SIZE, y = Math.floor(index / FACADE_EVIDENCE_SIZE);
			let boundary = false;
			for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
				const nx = x + dx, ny = y + dy;
				if (nx < 0 || nx >= FACADE_EVIDENCE_SIZE || ny < 0 || ny >= FACADE_EVIDENCE_SIZE) { boundary = true; break; }
				const neighbor = ny * FACADE_EVIDENCE_SIZE + nx;
				if (frame.triangleIds[neighbor] !== triangleId || Math.abs(frame.depths[neighbor] - frame.depths[index]) > range.span * 1e-4) { boundary = true; break; }
			}
			if (boundary) output[offset] = output[offset + 1] = output[offset + 2] = 15;
			continue;
		}
		if (triangleId < 0) {
			const background = mode === "normal" ? [127, 127, 127] : mode === "color" ? [242, 242, 240] : [0, 0, 0];
			output[offset] = background[0]; output[offset + 1] = background[1]; output[offset + 2] = background[2];
			continue;
		}
		let color;
		if (mode === "color") color = frame.colors[triangleId];
		else if (mode === "normal") color = frame.normals[triangleId].map((value) => Math.round((value * 0.5 + 0.5) * 255));
		else if (mode === "depth") {
			const value = Math.round(255 - ((frame.depths[index] - range.minimum) / range.span) * 205);
			color = [value, value, value];
		} else {
			color = [
				37 + (triangleId * 73) % 199,
				37 + (triangleId * 109) % 199,
				37 + (triangleId * 151) % 199,
			];
		}
		output[offset] = color[0]; output[offset + 1] = color[1]; output[offset + 2] = color[2];
	}
	return output;
}

async function atomicWrite(path, bytes) {
	const temporary = `${path}.tmp-${process.pid}-${temporarySequence++}`;
	try {
		await writeFile(temporary, bytes, { flag: "wx" });
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

export async function renderFacadeEvidencePasses({ mesh: meshInput, cameras, outputDir, modes, signal }) {
	throwIfAborted(signal);
	if (!exactNames(cameras, FACADE_EVIDENCE_VIEW_NAMES)) throw new Error("exactly seven named facade evidence cameras are required");
	if (!Array.isArray(modes) || modes.join("|") !== FACADE_EVIDENCE_PASS_NAMES.join("|")) throw new Error("exactly five facade evidence pass modes are required in fixed order");
	const mesh = validatedMesh(meshInput);
	const root = resolve(outputDir);
	await Promise.all(modes.map((mode) => mkdir(join(root, mode), { recursive: true })));
	const paths = {};
	for (const view of FACADE_EVIDENCE_VIEW_NAMES) {
		throwIfAborted(signal);
		const camera = { ...cameras[view], name: view };
		const frame = rasterize(mesh, camera, signal);
		for (const mode of modes) {
			const path = join(root, mode, `${view}.png`);
			const bytes = await sharp(passBuffer(frame, mode), { raw: { width: FACADE_EVIDENCE_SIZE, height: FACADE_EVIDENCE_SIZE, channels: 3 } })
				.png({ compressionLevel: 9, adaptiveFiltering: false, palette: false })
				.toBuffer();
			await atomicWrite(path, bytes);
			paths[`${mode}:${view}`] = path;
		}
	}
	return Object.fromEntries(FACADE_EVIDENCE_PASS_NAMES.flatMap((mode) =>
		FACADE_EVIDENCE_VIEW_NAMES.map((view) => [`${mode}:${view}`, paths[`${mode}:${view}`]])));
}
