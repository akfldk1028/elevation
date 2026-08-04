import { canonicalSurfaceSignature, compareCanonicalSurfaces } from "./geometry-signature.mjs";

function transformPoint(position, matrix) {
	const [x, y, z] = position;
	return [
		matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
		matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
		matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
	];
}

export function surfaceGeometryFromDocument(document) {
	const vertices = [];
	const triangles = [];
	for (const node of document.getRoot().listNodes()) {
		const mesh = node.getMesh();
		if (!mesh) continue;
		const matrix = node.getWorldMatrix();
		for (const primitive of mesh.listPrimitives()) {
			const position = primitive.getAttribute("POSITION");
			if (!position) continue;
			const offset = vertices.length;
			for (let index = 0; index < position.getCount(); index += 1) {
				vertices.push(transformPoint(position.getElement(index, [0, 0, 0]), matrix));
			}
			const indices = primitive.getIndices();
			const values = indices
				? Array.from({ length: indices.getCount() }, (_, index) => indices.getScalar(index))
				: Array.from({ length: position.getCount() }, (_, index) => index);
			for (let index = 0; index + 2 < values.length; index += 3) {
				triangles.push(values.slice(index, index + 3).map((value) => value + offset));
			}
		}
	}
	return { vertices, triangles };
}

export function documentSurfaceSignature(document) {
	return canonicalSurfaceSignature(surfaceGeometryFromDocument(document));
}

export function validateGeometryLock(authoritativeDocument, candidateDocument) {
	const authoritative = documentSurfaceSignature(authoritativeDocument);
	const candidate = documentSurfaceSignature(candidateDocument);
	return { ...compareCanonicalSurfaces(authoritative, candidate), authoritative, candidate };
}
