// ---------------- mood presets (lighting/sky/camera only; materials are the
// other three axes, applied in the app) ----
// Every value has a default equal to the original hardcoded one, so no mood
// means the original render exactly.

export const MOOD_PRESETS = {
	// Late-afternoon warm sun over a warm hazy sky.
	golden: {
		sky: { zenith: "#48648e", horizon: "#f0cda0", groundHaze: "#dcc4a2", sunColor: "#ffc788" },
		fog: "#ecdabd",
		exposure: 1.08,
		sunAzDeg: -46, sunAltDeg: 15,
		sunColor: 0xffc084, sunIntensity: 4.4,
		hemiSky: 0xc7d0e0, hemiGround: 0xa78e6f, hemiIntensity: 0.65,
		fillColor: 0xa9bdd6, fillIntensity: 0.4,
		envIntensity: 0.55,
	},
	// High cool morning sun, clear pale-blue sky.
	morning: {
		sky: { zenith: "#3f74bd", horizon: "#dfe9f2", groundHaze: "#ccd3d8", sunColor: "#fff3dd" },
		fog: "#e7edf2",
		exposure: 1.05,
		sunAzDeg: -30, sunAltDeg: 48,
		sunColor: 0xfff1dc, sunIntensity: 4.2,
		hemiSky: 0xbcd4ee, hemiGround: 0x9aa0a3, hemiIntensity: 0.8,
		fillColor: 0xb8cbe0, fillIntensity: 0.5,
		envIntensity: 0.6,
	},
	// Overcast-bright: weak cool sun, high ambient, low eye-level camera.
	overcast: {
		sky: { zenith: "#9db0bf", horizon: "#e3e9ed", groundHaze: "#d0d5d8", sunColor: "#f4f7fa" },
		fog: "#e3e8ec",
		exposure: 1.02,
		sunAzDeg: -38, sunAltDeg: 56,
		sunColor: 0xf2f6fa, sunIntensity: 1.6,
		hemiSky: 0xd3dde6, hemiGround: 0x9aa0a4, hemiIntensity: 1.35,
		fillColor: 0xc5ced6, fillIntensity: 0.6,
		envIntensity: 1.0,
		camHeight: 1.0,
	},
};

// Preset-aware lookup: the preset is passed in explicitly (no ambient module
// state), and every fallback equals the original hardcoded value.
export function styleValue(preset, key, fallback) {
	return preset && preset[key] !== undefined ? preset[key] : fallback;
}
