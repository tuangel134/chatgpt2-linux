"use strict";
// Codificador QR mínimo (versión 8-L, modo byte, máscara 0) para el emparejamiento del móvil.
// Portado del codificador de Forja Remote; sin dependencias. El mismo QR lo lee el escáner de la app Android.
const VERSION = 8;
const SIZE = 17 + VERSION * 4;
const DATA_BYTES = 194;
const ECC_BYTES_PER_BLOCK = 24;
const BLOCKS = 2;
const DATA_BYTES_PER_BLOCK = DATA_BYTES / BLOCKS;

function makeQr(payload) {
	const bytes = new TextEncoder().encode(payload);
	if (bytes.length > DATA_BYTES - 2) {
		throw new Error('The pairing address is too long to encode.');
	}
	const data = makeData(bytes);
	const blocks = [];
	for (let index = 0; index < BLOCKS; index++) {
		const block = data.slice(index * DATA_BYTES_PER_BLOCK, (index + 1) * DATA_BYTES_PER_BLOCK);
		blocks.push([...block, ...reedSolomon(block, ECC_BYTES_PER_BLOCK)]);
	}
	const codewords = [];
	for (let index = 0; index < DATA_BYTES_PER_BLOCK; index++) {
		for (const block of blocks) { codewords.push(block[index]); }
	}
	for (let index = DATA_BYTES_PER_BLOCK; index < DATA_BYTES_PER_BLOCK + ECC_BYTES_PER_BLOCK; index++) {
		for (const block of blocks) { codewords.push(block[index]); }
	}
	const modules = Array.from({ length: SIZE }, () => new Array(SIZE));
	placePatterns(modules);
	// Version information occupies the two 3x6 areas beside the top-right and
	// bottom-left finders and must be reserved before data is traversed.
	placeVersion(modules);
	placeData(modules, codewords);
	placeFormat(modules, 0); // Mask zero: (row + column) is even.
	return modules.map(row => row.map(cell => cell === true));
}

function makeData(payload) {
	const bits = [];
	const push = (value, length) => { for (let bit = length - 1; bit >= 0; bit--) { bits.push((value >>> bit) & 1); } };
	push(0b0100, 4); // byte mode
	push(payload.length, 8);
	for (const byte of payload) { push(byte, 8); }
	for (let i = 0; i < Math.min(4, DATA_BYTES * 8 - bits.length); i++) { bits.push(0); }
	while (bits.length % 8) { bits.push(0); }
	const data = [];
	for (let index = 0; index < bits.length; index += 8) {
		let value = 0;
		for (let bit = 0; bit < 8; bit++) { value = (value << 1) | bits[index + bit]; }
		data.push(value);
	}
	for (let pad = 0; data.length < DATA_BYTES; pad++) { data.push(pad % 2 ? 0x11 : 0xec); }
	return data;
}

function placePatterns(modules) {
	const finder = (row, column) => {
		for (let y = -1; y <= 7; y++) for (let x = -1; x <= 7; x++) {
			if (row + y < 0 || row + y >= SIZE || column + x < 0 || column + x >= SIZE) { continue; }
			modules[row + y][column + x] = y >= 0 && y <= 6 && x >= 0 && x <= 6 && (y === 0 || y === 6 || x === 0 || x === 6 || (y >= 2 && y <= 4 && x >= 2 && x <= 4));
		}
	};
	finder(0, 0); finder(SIZE - 7, 0); finder(0, SIZE - 7);
	for (let index = 8; index < SIZE - 8; index++) {
		if (modules[6][index] === undefined) { modules[6][index] = index % 2 === 0; }
		if (modules[index][6] === undefined) { modules[index][6] = index % 2 === 0; }
	}
	// Version 8 has alignment centres at 6, 24 and 42. Finder patterns occupy
	// the three corner centres, so only the remaining combinations are placed.
	const centers = [6, 24, 42];
	for (const row of centers) for (const column of centers) {
		if ((row === 6 && column === 6) || (row === 6 && column === 42) || (row === 42 && column === 6)) { continue; }
		for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) {
			modules[row + y][column + x] = Math.max(Math.abs(x), Math.abs(y)) !== 1;
		}
	}
	for (let index = 0; index < 9; index++) { if (modules[index][8] === undefined) modules[index][8] = false; if (modules[8][index] === undefined) modules[8][index] = false; }
	for (let index = SIZE - 8; index < SIZE; index++) { modules[index][8] = false; modules[8][index] = false; }
	modules[SIZE - 8][8] = true;
}

function placeVersion(modules) {
	// Version information uses BCH(18,6) with the QR version polynomial 0x1f25.
	let bits = VERSION << 12;
	while (bitLength(bits) >= bitLength(0x1f25)) { bits ^= 0x1f25 << (bitLength(bits) - bitLength(0x1f25)); }
	bits |= VERSION << 12;
	for (let index = 0; index < 18; index++) {
		const value = ((bits >>> index) & 1) === 1;
		const row = Math.floor(index / 3);
		const column = index % 3 + SIZE - 11;
		modules[row][column] = value;
		modules[column][row] = value;
	}
}

function placeData(modules, codewords) {
	let bitIndex = 0;
	let upward = true;
	for (let right = SIZE - 1; right > 0; right -= 2) {
		if (right === 6) { right--; }
		for (let offset = 0; offset < SIZE; offset++) {
			const row = upward ? SIZE - 1 - offset : offset;
			for (let column = right; column >= right - 1; column--) {
				if (modules[row][column] !== undefined) { continue; }
				const byte = codewords[Math.floor(bitIndex / 8)] ?? 0;
				const value = ((byte >>> (7 - (bitIndex % 8))) & 1) === 1;
				modules[row][column] = ((row + column) % 2 === 0) ? !value : value;
				bitIndex++;
			}
		}
		upward = !upward;
	}
}

function placeFormat(modules, mask) {
	let format = ((0b01 << 3) | mask) << 10; // error correction L
	const generator = 0x537;
	while (bitLength(format) >= bitLength(generator)) { format ^= generator << (bitLength(format) - bitLength(generator)); }
	format = ((((0b01 << 3) | mask) << 10) | format) ^ 0x5412;
	for (let index = 0; index < 15; index++) {
		const value = ((format >>> index) & 1) === 1;
		const row = index < 6 ? index : index < 8 ? index + 1 : SIZE - 15 + index;
		const column = index < 8 ? SIZE - index - 1 : index < 9 ? 15 - index : 15 - index - 1;
		modules[row][8] = value;
		modules[8][column] = value;
	}
	modules[SIZE - 8][8] = true;
}

function bitLength(value) { let length = 0; while (value) { length++; value >>>= 1; } return length; }

function reedSolomon(data, length) {
	const exp = new Array(512); const log = new Array(256); let value = 1;
	for (let index = 0; index < 255; index++) { exp[index] = value; log[value] = index; value <<= 1; if (value & 0x100) value ^= 0x11d; }
	for (let index = 255; index < 512; index++) exp[index] = exp[index - 255];
	let generator = [1];
	for (let index = 0; index < length; index++) {
		const next = new Array(generator.length + 1).fill(0);
		for (let term = 0; term < generator.length; term++) { next[term] ^= generator[term]; next[term + 1] ^= multiply(generator[term], exp[index], exp, log); }
		generator = next;
	}
	const remainder = new Array(length).fill(0);
	for (const byte of data) {
		const factor = byte ^ remainder.shift();
		remainder.push(0);
		for (let index = 0; index < length; index++) { remainder[index] ^= multiply(generator[index + 1], factor, exp, log); }
	}
	return remainder;
}

function multiply(left, right, exp, log) {
	return left === 0 || right === 0 ? 0 : exp[log[left] + log[right]];
}

/** Filas de "0"/"1" (sin margen) para dibujar el QR en cualquier sitio. */
function qrRows(payload) { return makeQr(payload).map((row) => row.map((c) => (c ? "1" : "0")).join("")); }

/** QR en texto para la terminal (bloques Unicode, 2 filas por línea, con margen de 2 módulos). */
function qrTerminal(payload) {
  const m = makeQr(payload), q = 2, n = SIZE + q * 2;
  const at = (r, c) => (r >= q && c >= q && r < n - q && c < n - q ? m[r - q][c - q] : false);
  const out = [];
  for (let r = 0; r < n; r += 2) {
    let line = "";
    for (let c = 0; c < n; c++) { const t = at(r, c), b = at(r + 1, c); line += t && b ? "█" : t ? "▀" : b ? "▄" : " "; }
    out.push(line);
  }
  return out.join("\n");
}

module.exports = { makeQr, qrRows, qrTerminal, SIZE };
