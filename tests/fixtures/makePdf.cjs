// Original synthetic workload; no personal documents or external PDF dependencies.
exports.makePdf = function (count) {
	const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>'];
	const kids = [];
	for (let i = 0; i < count; i++) {
		const id = objects.length + 1; kids.push(`${id} 0 R`);
		const lines = [`Synthetic page ${i + 1}${i === count - 1 ? ' finalmarker' : ''}`,
			...Array.from({ length: 34 }, (_, j) => `Synthetic paper line ${j} alpha beta gamma delta research sample.`)];
		const stream = 'BT /F1 11 Tf 30 550 Td 14 TL ' + lines.map(s => `(${s}) Tj T*`).join('\n') + ' ET';
		const box = i % 7 === 6 ? '0 0 792 612' : '0 0 612 792';
		objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [${box}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`);
		objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
	}
	objects[1] = `<< /Type /Pages /Count ${count} /Kids [${kids.join(' ')}] >>`;
	let out = '%PDF-1.4\n'; const offsets = [];
	objects.forEach((s, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${s}\nendobj\n`; });
	const xref = Buffer.byteLength(out);
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
	return Buffer.from(out + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
};
