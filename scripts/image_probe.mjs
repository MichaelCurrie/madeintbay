/**
 * Inspection of downloaded icon bytes: what format is this, and would it be
 * visible once drawn on the site's light cards?
 *
 * No dependency — keeps the Pages deploy free of an npm install step, which is
 * why the PNG reader below is hand-rolled rather than pulled from sharp et al.
 */

import { inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Identify the image by magic bytes rather than trusting Content-Type, because
 * the failure this has to catch is a server answering 200 with an HTML error
 * page or an empty body. Returns the extension, or null if it is not an image.
 */
export function imageExtension(buf) {
	if (buf.length < 16) {
		return null;
	}
	if (buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
		return "png";
	}
	if (buf.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
		return "jpg";
	}
	if (buf.subarray(0, 4).toString("ascii") === "GIF8") {
		return "gif";
	}
	if (
		buf.subarray(0, 4).toString("ascii") === "RIFF" &&
		buf.subarray(8, 12).toString("ascii") === "WEBP"
	) {
		return "webp";
	}
	if (buf.subarray(0, 2).toString("ascii") === "BM") {
		return "bmp";
	}
	// ICO and CUR share a header; byte 2 is the resource type.
	if (
		buf[0] === 0x00 &&
		buf[1] === 0x00 &&
		(buf[2] === 0x01 || buf[2] === 0x02) &&
		buf[3] === 0x00
	) {
		return "ico";
	}

	const head = buf.subarray(0, 1024).toString("utf8").trimStart();
	if (head.startsWith("<?xml") || head.startsWith("<svg") || head.startsWith("<!DOCTYPE svg")) {
		const svg = buf.toString("utf8");
		if (!/<svg[\s>]/i.test(svg)) {
			return null;
		}
		// These files end up served from madeintbay.ca, and an SVG opened
		// directly (not via <img>) runs its own script in this origin. Rather
		// than rewrite someone else's markup, refuse anything with an active
		// content vector and let the row fall back to the flag.
		if (/<script[\s>]|\son\w+\s*=|javascript:|<foreignObject[\s>]/i.test(svg)) {
			return null;
		}
		return "svg";
	}

	return null;
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a, b, c) {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Decode a PNG to flat RGBA. Returns null for the variants this does not
 * implement (16-bit samples, sub-byte palettes, Adam7 interlacing) — callers
 * treat that as "cannot tell" rather than as a defect in the image.
 */
function decodePngRgba(buf) {
	if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
		return null;
	}

	let width = 0;
	let height = 0;
	let colorType = 0;
	let palette = null;
	let paletteAlpha = null;
	const idat = [];

	for (let pos = 8; pos + 8 <= buf.length;) {
		const length = buf.readUInt32BE(pos);
		const type = buf.subarray(pos + 4, pos + 8).toString("ascii");
		const data = buf.subarray(pos + 8, pos + 8 + length);
		if (type === "IHDR") {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			const bitDepth = data[8];
			const interlace = data[12];
			colorType = data[9];
			if (bitDepth !== 8 || interlace !== 0 || !(colorType in CHANNELS)) {
				return null;
			}
		} else if (type === "PLTE") {
			palette = Buffer.from(data);
		} else if (type === "tRNS") {
			paletteAlpha = Buffer.from(data);
		} else if (type === "IDAT") {
			idat.push(Buffer.from(data));
		} else if (type === "IEND") {
			break;
		}
		pos += 12 + length;
	}

	if (!width || !height || idat.length === 0) {
		return null;
	}

	let raw;
	try {
		raw = inflateSync(Buffer.concat(idat));
	} catch {
		return null;
	}

	const channels = CHANNELS[colorType];
	const stride = width * channels;
	if (raw.length < (stride + 1) * height) {
		return null;
	}

	// Undo the per-scanline filter, which is defined against the reconstructed
	// bytes of the row above rather than the raw ones.
	const lines = Buffer.alloc(stride * height);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)];
		const src = y * (stride + 1) + 1;
		const dst = y * stride;
		for (let x = 0; x < stride; x++) {
			const value = raw[src + x];
			const a = x >= channels ? lines[dst + x - channels] : 0;
			const b = y > 0 ? lines[dst - stride + x] : 0;
			const c = x >= channels && y > 0 ? lines[dst - stride + x - channels] : 0;
			let out;
			if (filter === 0) out = value;
			else if (filter === 1) out = value + a;
			else if (filter === 2) out = value + b;
			else if (filter === 3) out = value + ((a + b) >> 1);
			else if (filter === 4) out = value + paeth(a, b, c);
			else return null;
			lines[dst + x] = out & 0xff;
		}
	}

	const rgba = Buffer.alloc(width * height * 4);
	for (let i = 0; i < width * height; i++) {
		const s = i * channels;
		const d = i * 4;
		if (colorType === 6 || colorType === 2) {
			rgba[d] = lines[s];
			rgba[d + 1] = lines[s + 1];
			rgba[d + 2] = lines[s + 2];
			rgba[d + 3] = colorType === 6 ? lines[s + 3] : 255;
		} else if (colorType === 0 || colorType === 4) {
			rgba[d] = rgba[d + 1] = rgba[d + 2] = lines[s];
			rgba[d + 3] = colorType === 4 ? lines[s + 1] : 255;
		} else {
			const index = lines[s];
			if (!palette || index * 3 + 2 >= palette.length) {
				return null;
			}
			rgba[d] = palette[index * 3];
			rgba[d + 1] = palette[index * 3 + 1];
			rgba[d + 2] = palette[index * 3 + 2];
			rgba[d + 3] = paletteAlpha && index < paletteAlpha.length ? paletteAlpha[index] : 255;
		}
	}

	return { width, height, rgba };
}

/**
 * Fraction of an icon that would actually read against the cards' near-white
 * background, or null when the format cannot be decoded here.
 *
 * This exists because a favicon can be perfectly valid and still be useless to
 * us: several sites ship a white-on-transparent logo, which looks right in a
 * dark browser tab strip and disappears completely on a light card. Each pixel
 * is composited onto the card colour first, exactly as a browser would, and
 * then counted as legible if the result is meaningfully darker than it.
 */
export function visibleFraction(buf, backdrop = 0xfa) {
	const image = decodePngRgba(buf);
	if (!image) {
		return null;
	}
	const { width, height, rgba } = image;
	let visible = 0;
	for (let i = 0; i < width * height; i++) {
		const d = i * 4;
		const alpha = rgba[d + 3] / 255;
		const r = rgba[d] * alpha + backdrop * (1 - alpha);
		const g = rgba[d + 1] * alpha + backdrop * (1 - alpha);
		const b = rgba[d + 2] * alpha + backdrop * (1 - alpha);
		// Rec. 709 luma, the same weighting browsers use for contrast maths.
		if (0.2126 * r + 0.7152 * g + 0.0722 * b < 200) {
			visible++;
		}
	}
	return visible / (width * height);
}
