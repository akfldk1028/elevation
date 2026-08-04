import { createTripoProvider } from "./providers/tripo.mjs";

export function createTexturingProvider(name, options) {
	if (name === "tripo") return createTripoProvider(options);
	throw new Error(`Unsupported texturing provider: ${name}`);
}
