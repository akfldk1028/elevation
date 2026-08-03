import { createReadStream } from "node:fs";

export function buildHunyuanRequest({ fileUrl, prompt, plan }) {
	const config = plan.providers.hunyuan;
	return { File3D: { Type: "OBJ", Url: fileUrl }, Model: config.model, Prompt: prompt, EnablePBR: config.enable_pbr, EnableKeepUV: config.enable_keep_uv, TextureSize: config.texture_size };
}

export function normalizeHunyuanStatus(response) {
	const files = (response.ResultFile3Ds ?? []).map((item) => ({ type: item.Type, url: item.Url }));
	if (response.Status === "DONE") return { status: "succeeded", files };
	if (response.Status === "FAIL") return { status: "failed", code: response.ErrorCode, message: response.ErrorMessage, files };
	return { status: response.Status === "RUN" ? "running" : "pending", files };
}

export async function createHunyuanProvider(env = process.env) {
	for (const key of ["TENCENTCLOUD_SECRET_ID", "TENCENTCLOUD_SECRET_KEY", "TENCENT_COS_BUCKET"]) if (!env[key]) throw new Error(`${key} is required`);
	const [{ ai3d }, cosModule] = await Promise.all([import("tencentcloud-sdk-nodejs-ai3d"), import("cos-nodejs-sdk-v5")]);
	const client = new ai3d.v20250513.Client({ credential: { secretId: env.TENCENTCLOUD_SECRET_ID, secretKey: env.TENCENTCLOUD_SECRET_KEY }, region: "ap-guangzhou", profile: { httpProfile: { endpoint: "ai3d.tencentcloudapi.com", reqTimeout: 60 } } });
	const COS = cosModule.default;
	const cos = new COS({ SecretId: env.TENCENTCLOUD_SECRET_ID, SecretKey: env.TENCENTCLOUD_SECRET_KEY });
	const bucket = env.TENCENT_COS_BUCKET;
	const region = env.TENCENT_COS_REGION || "ap-guangzhou";
	const callCos = (method, params) => new Promise((resolve, reject) => cos[method](params, (error, data) => error ? reject(error) : resolve(data)));
	return {
		async stageFile(localPath, key) {
			await callCos("putObject", { Bucket: bucket, Region: region, Key: key, Body: createReadStream(localPath) });
			return cos.getObjectUrl({ Bucket: bucket, Region: region, Key: key, Sign: true, Expires: 86400 });
		},
		async cleanup(key) { await callCos("deleteObject", { Bucket: bucket, Region: region, Key: key }); },
		async submit(request) { return client.SubmitTextureTo3DJob(request); },
		async status(jobId) { return normalizeHunyuanStatus(await client.DescribeTextureTo3DJob({ JobId: jobId })); },
	};
}
