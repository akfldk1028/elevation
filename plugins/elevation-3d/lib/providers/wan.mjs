export function buildWanRequest({ images, prompt, plan }) {
	const config = plan.providers.wan;
	return { model: config.model, input: { messages: [{ role: "user", content: [...images.map((image) => ({ image })), { text: prompt }] }] }, parameters: { size: config.size, n: config.n, enable_sequential: config.enable_sequential, watermark: config.watermark } };
}

export function normalizeWanStatus(response) {
	const output = response.output ?? {};
	const images = (output.choices ?? []).flatMap((choice) => choice.message?.content ?? []).filter((item) => item.type === "image" && item.image).map((item) => item.image);
	const raw = output.task_status;
	const status = raw === "SUCCEEDED" ? "succeeded" : raw === "FAILED" || raw === "CANCELED" ? "failed" : raw === "RUNNING" ? "running" : "pending";
	return { status, task_id: output.task_id, images, ...(status === "failed" ? { code: response.code, message: response.message } : {}) };
}

export function createWanProvider(env = process.env) {
	for (const key of ["DASHSCOPE_API_KEY", "DASHSCOPE_WORKSPACE_ID"]) if (!env[key]) throw new Error(`${key} is required`);
	const base = `https://${env.DASHSCOPE_WORKSPACE_ID}.cn-beijing.maas.aliyuncs.com/api/v1`;
	const headers = { Authorization: `Bearer ${env.DASHSCOPE_API_KEY}`, "Content-Type": "application/json" };
	return {
		async submit(request) {
			const response = await fetch(`${base}/services/aigc/image-generation/generation`, { method: "POST", headers: { ...headers, "X-DashScope-Async": "enable" }, body: JSON.stringify(request) });
			const body = await response.json();
			if (!response.ok) throw new Error(`Wan submit failed (${response.status}): ${body.message ?? body.code ?? "unknown error"}`);
			return normalizeWanStatus(body);
		},
		async status(taskId) {
			const response = await fetch(`${base}/tasks/${encodeURIComponent(taskId)}`, { headers });
			const body = await response.json();
			if (!response.ok) throw new Error(`Wan status failed (${response.status}): ${body.message ?? body.code ?? "unknown error"}`);
			return normalizeWanStatus(body);
		},
	};
}
