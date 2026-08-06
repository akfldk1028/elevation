import { createHash } from "node:crypto";
import sharp from "sharp";

import { FacadeImageBoundaryError } from "./response-boundary.mjs";

export const FACADE_PROVIDER_IMAGE_LIMITS = Object.freeze({
	maxEncodedBytes: 32 * 1024 * 1024,
	maxPixels: 16_777_216,
	maxDecodedBytes: 64 * 1024 * 1024,
});

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function fail(code, message) {
	throw new FacadeImageBoundaryError(code, message);
}
export async function decodeBoundedProviderImage({ bytes: input, expectedMimeType = "image/png" } = {}) {
	if (expectedMimeType !== "image/png") fail("PROVIDER_IMAGE_INVALID", "Facade provider output must be PNG");
	if (!Buffer.isBuffer(input) && !(input instanceof Uint8Array)) fail("PROVIDER_IMAGE_INVALID", "Facade provider image bytes are required");
	const bytes = Buffer.from(input);
	if (bytes.length === 0 || bytes.length > FACADE_PROVIDER_IMAGE_LIMITS.maxEncodedBytes) fail("PROVIDER_IMAGE_TOO_LARGE", "Facade provider image exceeds the encoded byte limit");
	if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) fail("PROVIDER_IMAGE_INVALID", "Facade provider image must have a PNG signature");
	let decoded;
	try {
		decoded = await sharp(bytes, { limitInputPixels: FACADE_PROVIDER_IMAGE_LIMITS.maxPixels, failOn: "error" }).raw().toBuffer({ resolveWithObject: true });
	} catch {
		fail("PROVIDER_IMAGE_INVALID", "Facade provider PNG did not fully decode");
	}
	const { width, height, channels } = decoded.info;
	const decodedBytes = width * height * channels;
	if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1
		|| !Number.isSafeInteger(channels) || channels < 1 || channels > 4
		|| width * height > FACADE_PROVIDER_IMAGE_LIMITS.maxPixels
		|| decodedBytes > FACADE_PROVIDER_IMAGE_LIMITS.maxDecodedBytes
		|| decoded.data.length !== decodedBytes) fail("PROVIDER_IMAGE_INVALID", "Facade provider PNG dimensions are invalid");
	return Object.freeze({
		bytes,
		mimeType: "image/png",
		width,
		height,
		channels,
		byteSize: bytes.length,
		sha256: createHash("sha256").update(bytes).digest("hex"),
	});
}

export async function decodeBoundedBase64Png(value) {
	if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) fail("PROVIDER_RESPONSE_INVALID", "Provider returned malformed base64 image data");
	const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
	const decodedLength = Math.floor(value.length / 4) * 3 - padding;
	if (decodedLength > FACADE_PROVIDER_IMAGE_LIMITS.maxEncodedBytes) fail("PROVIDER_IMAGE_TOO_LARGE", "Facade provider image exceeds the encoded byte limit");
	for (let index = 0; index < value.length - padding; index += 1) {
		const code = value.charCodeAt(index);
		if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 43 || code === 47)) {
			fail("PROVIDER_RESPONSE_INVALID", "Provider returned malformed base64 image data");
		}
	}
	for (let index = value.length - padding; index < value.length; index += 1) if (value.charCodeAt(index) !== 61) fail("PROVIDER_RESPONSE_INVALID", "Provider returned malformed base64 image data");
	return decodeBoundedProviderImage({ bytes: Buffer.from(value, "base64") });
}
