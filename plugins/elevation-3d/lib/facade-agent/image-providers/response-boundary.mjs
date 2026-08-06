import { redactSecrets } from "../../core.mjs";

const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_MAX_NODES = 4_096;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export class FacadeImageBoundaryError extends Error {
	constructor(code, message) {
		super(message);
		this.name = "FacadeImageBoundaryError";
		this.code = code;
		this.definitiveNonSubmission = true;
	}
}
function fail(message) {
	throw new FacadeImageBoundaryError("PROVIDER_BOUNDARY_INVALID", message);
}

function freezeTree(value) {
	if (!value || typeof value !== "object" || Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return value;
	for (const item of Object.values(value)) freezeTree(item);
	return Object.freeze(value);
}

export function cloneBoundedPlainData(value, options = {}) {
	const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
	const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
	const seen = new Set();
	let nodes = 0;

	function clone(item, depth) {
		if (depth > maxDepth || ++nodes > maxNodes) fail("Provider boundary data exceeds its structural limit");
		if (item === null || typeof item === "string" || typeof item === "boolean") return item;
		if (typeof item === "number" && Number.isFinite(item)) return item;
		if (typeof item !== "object" || seen.has(item)) fail("Provider boundary data must contain finite acyclic plain data");
		seen.add(item);
		let prototype;
		let descriptors;
		try {
			prototype = Object.getPrototypeOf(item);
			descriptors = Object.getOwnPropertyDescriptors(item);
		} catch {
			fail("Provider boundary data could not be inspected safely");
		}
		if (Array.isArray(item)) {
			if (prototype !== Array.prototype) fail("Provider boundary arrays must use the built-in prototype");
			const length = descriptors.length?.value;
			const keys = Reflect.ownKeys(descriptors).filter((key) => key !== "length");
			if (!Number.isSafeInteger(length) || length < 0 || keys.length !== length) fail("Provider boundary arrays must be dense");
			const result = new Array(length);
			for (const key of keys) {
				const descriptor = descriptors[key];
				if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key) || descriptor.get || descriptor.set || !("value" in descriptor)) fail("Provider boundary arrays cannot contain accessors");
				const index = Number(key);
				if (index >= length) fail("Provider boundary array index is invalid");
				result[index] = clone(descriptor.value, depth + 1);
			}
			return result;
		}
		if (prototype !== Object.prototype && prototype !== null) fail("Provider boundary objects must be plain");
		const keys = Reflect.ownKeys(descriptors);
		const result = {};
		for (const key of keys) {
			const descriptor = descriptors[key];
			if (typeof key !== "string" || DANGEROUS_KEYS.has(key) || descriptor.get || descriptor.set || !("value" in descriptor)) fail("Provider boundary objects cannot contain dangerous keys or accessors");
			result[key] = clone(descriptor.value, depth + 1);
		}
		return result;
	}

	return freezeTree(clone(value, 0));
}

export function redactBoundedPlainData(value, options = {}) {
	return freezeTree(redactSecrets(cloneBoundedPlainData(value, options)));
}
