#!/usr/bin/env node
import { runFacadeAgentCli } from "../plugins/elevation-3d/lib/facade-agent/cli.mjs";

const controller = new AbortController();
const cancel = () => controller.abort(new DOMException("Facade agent command cancelled", "AbortError"));
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
try {
	const fetchImpl = globalThis.fetch?.bind(globalThis);
	process.exitCode = await runFacadeAgentCli(process.argv.slice(2), { signal: controller.signal, fetchImpl });
} finally {
	process.removeListener("SIGINT", cancel);
	process.removeListener("SIGTERM", cancel);
}
