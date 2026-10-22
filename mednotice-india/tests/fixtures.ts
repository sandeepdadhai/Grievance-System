/** Build a minimal but structurally valid PDF with an uncompressed text stream. */
export function buildPdf(opts: {
  text?: string;
  producer?: string;
  creator?: string;
  creationDate?: string;
  modDate?: string;
  revisions?: number;
  baseFont?: string;
  signed?: boolean;
  extra?: string;
} = {}): Buffer {
  const text = opts.text ?? "Patient Name: John Doe\nPhysician: Arjun Mehta\nLicense: DL-48291\nFacility: All India Institute of Medical Sciences\nDiagnosis: I21.4\nDate of Service: 2026-10-01";
  const escaped = text.replace(/([()\\])/g, "\\$1").replace(/\n/g, ") Tj T* (");
  const content = `BT /F1 12 Tf 50 700 Td (${escaped}) Tj ET`;
  const producer = opts.producer ?? "Epic Systems Corporation";
  const creator = opts.creator ?? "Epic Hyperspace";
  const creationDate = opts.creationDate ?? "D:20261001120000Z";
  const modDate = opts.modDate ?? creationDate;
  const baseFont = opts.baseFont ?? "Helvetica";
  const revisionCount = opts.revisions ?? 0;

  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /${baseFont} >>`,
    `<< /Producer (${producer}) /Creator (${creator}) /CreationDate (${creationDate}) /ModDate (${modDate})${opts.signed ? " /Type /Sig /ByteRange [0 100 200 300]" : ""}${opts.extra ?? ""} >>`,
  ];

  let pdf = "%PDF-1.7\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  // Additional incremental revisions simulate documents saved after issuance.
  for (let r = 0; r < revisionCount; r += 1) {
    const objNum = objects.length + 1 + r;
    pdf += `${objNum} 0 obj\n<< /Producer (${producer}) /ModDate (D:20261002${String(10 + r).padStart(2, "0")}0000Z) >>\nendobj\n`;
    const start = pdf.length;
    pdf += `xref\n${objNum} 1\n${String(start).padStart(10, "0")} 00000 n \ntrailer\n<< /Size ${objNum + 1} /Root 1 0 R /Prev ${xrefStart} >>\nstartxref\n${start}\n%%EOF\n`;
  }
  return Buffer.from(pdf, "latin1");
}

/** PNG with an IHDR chunk (1x1 placeholder dimensions are configurable). */
export function buildPng(opts: { width?: number; height?: number; software?: string } = {}): Buffer {
  const width = opts.width ?? 1200;
  const height = opts.height ?? 1600;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write("IHDR", 4, "latin1");
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  ihdr[17] = 2;
  const text = opts.software ? Buffer.concat([Buffer.from("tEXtSoftware\0", "latin1"), Buffer.from(opts.software, "latin1")]) : Buffer.alloc(0);
  return Buffer.concat([signature, ihdr, text, Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])]);
}
