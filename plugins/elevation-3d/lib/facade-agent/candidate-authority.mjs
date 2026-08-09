import { redactSecrets, sha256, stableJson } from "../core.mjs";

export function persistentFacadeValue(value, seen = new Set(), depth = 0) {
	if (depth > 32) return "[OMITTED_DEPTH]";
	if (Buffer.isBuffer(value) || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return "[OMITTED_BINARY]";
	if (value === null || ["string", "boolean"].includes(typeof value)) return redactSecrets(value);
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value !== "object") return undefined;
	if (seen.has(value)) return "[OMITTED_CYCLE]";
	seen.add(value);
	if (Array.isArray(value)) return value.map((item) => persistentFacadeValue(item, seen, depth + 1));
	const output = {};
	for (const [key, item] of Object.entries(value)) {
		if (/(remote[_-]?id|url)$/i.test(key)) continue;
		const safe = persistentFacadeValue(item, seen, depth + 1);
		if (safe !== undefined) output[key] = safe;
	}
	return redactSecrets(output);
}

export function facadeCandidateHash(candidate) {
	return sha256(stableJson(persistentFacadeValue(candidate)));
}
