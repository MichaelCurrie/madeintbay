/**
 * Minimal RFC 4180 CSV read/write, shared by the deploy scripts.
 *
 * No dependency — keeps the Pages deploy free of an npm install step.
 */

/** Parse CSV text into an array of row objects keyed by the header row. */
export function parseCsv(text) {
	const rows = [];
	let row = [];
	let field = "";
	let inQuotes = false;

	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (inQuotes) {
			if (char === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				field += char;
			}
		} else if (char === '"') {
			inQuotes = true;
		} else if (char === ",") {
			row.push(field);
			field = "";
		} else if (char === "\n" || char === "\r") {
			if (char === "\r" && text[i + 1] === "\n") {
				i++;
			}
			row.push(field);
			if (row.some((cell) => cell !== "")) {
				rows.push(row);
			}
			row = [];
			field = "";
		} else {
			field += char;
		}
	}
	if (field !== "" || row.length > 0) {
		row.push(field);
		if (row.some((cell) => cell !== "")) {
			rows.push(row);
		}
	}

	if (rows.length === 0) {
		return { headers: [], rows: [] };
	}

	const headers = rows[0].map((h) => h.trim());
	return {
		headers,
		rows: rows.slice(1).map((cells) => {
			const obj = {};
			headers.forEach((header, index) => {
				obj[header] = (cells[index] ?? "").trim();
			});
			return obj;
		}),
	};
}

/**
 * Serialise row objects back to CSV. Only the delimiters and quote character
 * force quoting, so plain values stay unquoted and the output keeps reading
 * like the hand-edited original.
 */
export function stringifyCsv(headers, rows) {
	const escape = (value) => {
		const cell = value ?? "";
		return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
	};
	const lines = [headers.join(",")];
	for (const row of rows) {
		lines.push(headers.map((header) => escape(row[header])).join(","));
	}
	return `${lines.join("\n")}\n`;
}
