import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { redactSecrets } from "../plugins/elevation-3d/lib/core.mjs";
import { TexturingError } from "../plugins/elevation-3d/lib/texturing/contract.mjs";
import { deliverTexturedGlb } from "../plugins/elevation-3d/lib/texturing/delivery.mjs";
import { texturingRequestKey } from "../plugins/elevation-3d/lib/texturing/paid-task-ledger.mjs";

const execFileAsync = promisify(execFile);

export function parseEnvText(text) {
	const values = {};
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
		if (!match) throw new Error("Invalid dotenv assignment");
		let value = match[2].trim();
		if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
		values[match[1]] = value;
	}
	return values;
}

export function parseTripoCliArgs(argv) {
	const result = { maxCredits: 15, seed: 13013, confirmLive: false, dryRun: false };
	const valueFlags = new Map([
		["--accepted-glb", "acceptedGlb"],
		["--reference-image", "referenceImage"],
		["--result-dir", "resultDir"],
		["--run-root", "runRoot"],
		["--procedural-delivery", "proceduralDelivery"],
		["--env-file", "envFile"],
		["--max-credits", "maxCredits"],
		["--seed", "seed"],
	]);
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--confirm-live") { result.confirmLive = true; continue; }
		if (argument === "--dry-run") { result.dryRun = true; continue; }
		const field = valueFlags.get(argument);
		if (!field) throw new Error(`Unknown argument: ${argument}`);
		const value = argv[index + 1];
		if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
		result[field] = ["maxCredits", "seed"].includes(field) ? Number(value) : value;
		index += 1;
	}
	for (const field of ["acceptedGlb", "referenceImage", "resultDir"]) if (!result[field]) throw new Error(`--${field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
	if (!Number.isInteger(result.maxCredits) || result.maxCredits < 1 || result.maxCredits > 15) throw new Error("--max-credits must be an integer from 1 through 15");
	if (!Number.isInteger(result.seed)) throw new Error("--seed must be an integer");
	return result;
}

async function findEnvFile(start) {
	let current = resolve(start);
	for (;;) {
		const candidate = resolve(current, ".env");
		try { await access(candidate); return candidate; } catch { /* continue upward */ }
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

async function assertEnvIgnored(path) {
	try {
		await execFileAsync("git", ["-C", dirname(path), "check-ignore", "-q", "--", path], { windowsHide: true });
	} catch {
		throw new TexturingError("ENV_FILE_NOT_IGNORED", "Refusing to load a Tripo key from an environment file that is not Git-ignored");
	}
}

export async function runTripoCli({ argv = process.argv.slice(2), env = process.env, stdout = process.stdout, cwd = process.cwd(), deliver = deliverTexturedGlb } = {}) {
	const args = parseTripoCliArgs(argv);
	const discoveredEnvPath = args.envFile ?? await findEnvFile(cwd);
	if (!discoveredEnvPath) throw new TexturingError("ENV_FILE_MISSING", "No .env file was found");
	const envPath = resolve(discoveredEnvPath);
	await assertEnvIgnored(envPath);
	const localEnv = parseEnvText(await readFile(envPath, "utf8"));
	for (const [key, value] of Object.entries(localEnv)) if (env[key] === undefined) env[key] = value;
	if (typeof env.TRIPO_API_KEY !== "string" || !/^tsk_[A-Za-z0-9_-]{16,}$/.test(env.TRIPO_API_KEY)) {
		throw new TexturingError("TRIPO_KEY_MISSING", "TRIPO_API_KEY is missing or malformed");
	}
	const result = await deliver({
		acceptedGlb: resolve(args.acceptedGlb),
		referenceImage: resolve(args.referenceImage),
		resultDir: resolve(args.resultDir),
		runRoot: resolve(args.runRoot ?? dirname(resolve(args.resultDir))),
		proceduralDelivery: args.proceduralDelivery ? resolve(args.proceduralDelivery) : null,
		provider: "tripo",
		providerOptions: { apiKey: env.TRIPO_API_KEY },
		confirmLive: args.confirmLive,
		maxCredits: args.maxCredits,
		seed: args.seed,
		dryRun: args.dryRun,
		env,
	});
	const summary = redactSecrets({
		status: result.status,
		balance: result.balance,
		requestHash: result.request ? texturingRequestKey(result.request) : result.requestHash,
		acceptedGlbHash: result.request?.acceptedGlbHash,
		referenceImageHash: result.request?.referenceImageHash,
		preparedGlbHash: result.preparation?.outputSha256,
		outputSha256: result.outputSha256,
		actualCredits: result.actualCredits,
		maxCredits: args.maxCredits,
		resultDir: resolve(args.resultDir),
		failure: result.failure,
	});
	stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
	return result;
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
	runTripoCli().catch((error) => {
		process.stderr.write(`${JSON.stringify(redactSecrets({ code: error?.code ?? "TRIPO_HARNESS_FAILED", message: error?.message ?? String(error) }))}\n`);
		process.exitCode = 1;
	});
}
