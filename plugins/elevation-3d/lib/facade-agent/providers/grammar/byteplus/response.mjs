import { validatePunchedFacadeGrammar } from "../../../../facade-grammar.mjs";

const MAX_DEPTH = 32;
const MAX_NODES = 16_384;
const SAFE_REMOTE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class BytePlusGrammarResponseError extends Error {
	constructor(code, message, remoteId = null) {
		super(message);
		this.name = "BytePlusGrammarResponseError";
		this.code = code;
		this.remoteId = remoteId;
	}
}

function invalid(message = "BytePlus returned invalid response data", remoteId = null) {
	throw new BytePlusGrammarResponseError("INVALID_PROVIDER_RESPONSE", message, remoteId);
}

export function parseBytePlusJson(text) {
	if (typeof text !== "string") invalid();
	let offset = 0;
	let nodes = 0;
	const whitespace = () => { while (/[\u0009\u000a\u000d\u0020]/.test(text[offset] ?? "")) offset += 1; };
	const string = () => {
		if (text[offset] !== '"') invalid();
		const start = offset++;
		while (offset < text.length) {
			const code = text.charCodeAt(offset);
			if (code < 0x20) invalid();
			if (text[offset] === '"') {
				offset += 1;
				try { return JSON.parse(text.slice(start, offset)); }
				catch { invalid(); }
			}
			if (text[offset] === "\\") {
				offset += 1;
				if (text[offset] === "u") {
					if (!/^[a-fA-F0-9]{4}$/.test(text.slice(offset + 1, offset + 5))) invalid();
					offset += 5;
					continue;
				}
				if (!/["\\/bfnrt]/.test(text[offset] ?? "")) invalid();
			}
			offset += 1;
		}
		invalid();
	};
	const value = (depth = 0) => {
		whitespace();
		if (depth > MAX_DEPTH || ++nodes > MAX_NODES) invalid("BytePlus response exceeds the plain-data boundary");
		if (text[offset] === '"') return string();
		if (text[offset] === "{") {
			offset += 1;
			const result = {};
			const keys = new Set();
			whitespace();
			if (text[offset] === "}") { offset += 1; return result; }
			while (offset < text.length) {
				whitespace();
				const key = string();
				if (keys.has(key) || ["__proto__", "prototype", "constructor"].includes(key)) invalid("BytePlus response contains duplicate or unsafe keys");
				keys.add(key);
				whitespace();
				if (text[offset++] !== ":") invalid();
				Object.defineProperty(result, key, { value: value(depth + 1), enumerable: true, configurable: true, writable: true });
				whitespace();
				if (text[offset] === "}") { offset += 1; return result; }
				if (text[offset++] !== ",") invalid();
			}
			invalid();
		}
		if (text[offset] === "[") {
			offset += 1;
			const result = [];
			whitespace();
			if (text[offset] === "]") { offset += 1; return result; }
			while (offset < text.length) {
				result.push(value(depth + 1));
				whitespace();
				if (text[offset] === "]") { offset += 1; return result; }
				if (text[offset++] !== ",") invalid();
			}
			invalid();
		}
		for (const [token, parsed] of [["true", true], ["false", false], ["null", null]]) {
			if (text.startsWith(token, offset)) { offset += token.length; return parsed; }
		}
		const number = text.slice(offset).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
		if (!number) invalid();
		offset += number[0].length;
		const parsed = Number(number[0]);
		if (!Number.isFinite(parsed)) invalid();
		return parsed;
	};
	const parsed = value();
	whitespace();
	if (offset !== text.length) invalid();
	return parsed;
}

export function selectBytePlusGrammarRemoteId(payload, headerRemoteId = null) {
	for (const value of [headerRemoteId, payload?.id, payload?.request_id]) {
		if (typeof value === "string" && SAFE_REMOTE_ID.test(value)) return value;
	}
	return null;
}

function usageRecord(value, remoteId) {
	if (value === undefined || value === null) return { actualUsd: null, usage: null };
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid(undefined, remoteId);
	const numeric = (key) => {
		const item = value[key];
		if (item === undefined) return undefined;
		if (!Number.isSafeInteger(item) || item < 0) invalid(undefined, remoteId);
		return item;
	};
	const inputTokens = numeric("input_tokens");
	const outputTokens = numeric("output_tokens");
	const totalTokens = numeric("total_tokens");
	const reportedCost = value.cost_usd;
	if (reportedCost !== undefined && (!Number.isFinite(reportedCost) || reportedCost < 0)) invalid(undefined, remoteId);
	const usage = {};
	if (inputTokens !== undefined) usage.inputTokens = inputTokens;
	if (outputTokens !== undefined) usage.outputTokens = outputTokens;
	if (totalTokens !== undefined) usage.totalTokens = totalTokens;
	return { actualUsd: reportedCost ?? null, usage: Object.keys(usage).length ? usage : null };
}

export function decodeBytePlusGrammarResponse(payload, { headerRemoteId = null } = {}) {
	if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.getPrototypeOf(payload) !== Object.prototype) invalid();
	const remoteId = selectBytePlusGrammarRemoteId(payload, headerRemoteId);
	if (payload.status !== undefined && payload.status !== "completed") invalid("BytePlus grammar response did not complete", remoteId);
	if (!Array.isArray(payload.output) || payload.output.length !== 1) invalid(undefined, remoteId);
	const message = payload.output[0];
	if (!message || message.type !== "message" || message.role !== "assistant" || !Array.isArray(message.content) || message.content.length !== 1) invalid(undefined, remoteId);
	const content = message.content[0];
	if (content?.type === "refusal") throw new BytePlusGrammarResponseError("CONTENT_REJECTED", "BytePlus rejected the grammar content", remoteId);
	if (!content || content.type !== "output_text" || typeof content.text !== "string" || !content.text.length) invalid(undefined, remoteId);
	let parsedGrammar;
	try { parsedGrammar = parseBytePlusJson(content.text); }
	catch (error) {
		if (error instanceof BytePlusGrammarResponseError) throw new BytePlusGrammarResponseError("INVALID_PROVIDER_RESPONSE", "BytePlus returned invalid structured output", remoteId);
		throw error;
	}
	let validated;
	try { validated = validatePunchedFacadeGrammar(parsedGrammar); }
	catch { throw new BytePlusGrammarResponseError("INVALID_GRAMMAR", "BytePlus returned invalid facade grammar", remoteId); }
	const accounting = usageRecord(payload.usage, remoteId);
	return {
		grammarCandidate: JSON.stringify(validated),
		remoteId,
		actualUsd: accounting.actualUsd,
		usage: accounting.usage,
	};
}
