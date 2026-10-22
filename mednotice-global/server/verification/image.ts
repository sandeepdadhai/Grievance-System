import type { DocumentKind, Finding } from "./types.js";

export type ImageAnalysis = {
  kind: DocumentKind;
  validMagic: boolean;
  dimensions: { width: number; height: number } | null;
  softwareTags: string[];
  trailingBytes: number;
  duplicateMarkers: number;
  dicomMeta: Record<string, string>;
  text: string;
  findings: Finding[];
};

const EDITOR_SIGNATURES: Array<{ re: RegExp; weight: number; severity: Finding["severity"] }> = [
  { re: /adobe photoshop/i, weight: -30, severity: "high" },
  { re: /adobe lightroom/i, weight: -12, severity: "low" },
  { re: /gimp/i, weight: -28, severity: "high" },
  { re: /snapseed|picsart|pixlr|facetune|beautycam/i, weight: -24, severity: "high" },
  { re: /canva|pixelmator|affinity photo/i, weight: -26, severity: "high" },
  { re: /microsoft paint|paint\.net/i, weight: -22, severity: "medium" },
  { re: /imagemagick|graphicsmagick/i, weight: -18, severity: "medium" },
  { re: /whatsapp|telegram|facebook/i, weight: -10, severity: "medium" },
];

export function sniffKind(buf: Buffer, mime: string, filename: string): DocumentKind {
  const head = buf.subarray(0, 16);
  if (head.toString("latin1").startsWith("%PDF-")) return "PDF";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "JPEG";
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "PNG";
  if (buf.length > 132 && buf.subarray(128, 132).toString("latin1") === "DICM") return "DICOM";
  if (/dicom|dcm/i.test(mime) || /\.dcm$/i.test(filename)) return "DICOM";
  return "UNKNOWN";
}

function jpegDimensions(buf: Buffer): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buf[offset + 1];
    const len = buf.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }
    offset += 2 + len;
  }
  return null;
}

function pngDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function extractSoftwareTags(buf: Buffer): string[] {
  const sample = buf.subarray(0, Math.min(buf.length, 256 * 1024)).toString("latin1");
  const tags = new Set<string>();
  for (const { re } of EDITOR_SIGNATURES) {
    const m = sample.match(re);
    if (m) tags.add(m[0]);
  }
  const tEXt = [...sample.matchAll(/(?:Software|CreatorTool|ProcessingSoftware)\0([\x20-\x7e]{2,60})/g)].map((m) => m[1]);
  for (const t of tEXt) tags.add(t.trim());
  return [...tags];
}

function parseDicom(buf: Buffer): Record<string, string> {
  const meta: Record<string, string> = {};
  const text = buf.subarray(0, Math.min(buf.length, 128 * 1024)).toString("latin1");
  const wanted: Array<[string, RegExp]> = [
    ["PatientName", /([\x20-\x7e]{2,64})\s*\(0010,0010\)|\(0010,0010\)\s*([\x20-\x7e]{2,64})/],
    ["PatientID", /([\x20-\x7e]{2,64})\s*\(0010,0020\)|\(0010,0020\)\s*([\x20-\x7e]{2,64})/],
    ["StudyDate", /([0-9]{8})\s*\(0008,0020\)|\(0008,0020\)\s*([0-9]{8})/],
    ["Modality", /([A-Z]{2,4})\s*\(0008,0060\)|\(0008,0060\)\s*([A-Z]{2,4})/],
    ["InstitutionName", /([\x20-\x7e]{2,64})\s*\(0008,0080\)|\(0008,0080\)\s*([\x20-\x7e]{2,64})/],
    ["Manufacturer", /([\x20-\x7e]{2,64})\s*\(0008,0070\)|\(0008,0070\)\s*([\x20-\x7e]{2,64})/],
  ];
  // Also support human-readable "DICOM metadata report" exports: "PatientName: X"
  for (const [key, re] of wanted) {
    const binary = text.match(re);
    const labeled = text.match(new RegExp(`${key}\\s*[:=]\\s*([\\x20-\\x7e]{2,64})`, "i"));
    const value = (binary?.[1] ?? binary?.[2] ?? labeled?.[1] ?? "").trim();
    if (value) meta[key] = value;
  }
  return meta;
}

export function analyzeImage(buf: Buffer, mime: string, filename: string): ImageAnalysis {
  const findings: Finding[] = [];
  const kind = sniffKind(buf, mime, filename);
  const declaredIsPdf = /pdf/i.test(mime) || /\.pdf$/i.test(filename);
  const declaredIsImage = /image\/(jpeg|png)/i.test(mime) || /\.(jpe?g|png)$/i.test(filename);

  const validMagic =
    (kind === "PDF" && declaredIsPdf) ||
    (kind === "JPEG" && declaredIsImage) ||
    (kind === "PNG" && declaredIsImage) ||
    (kind === "DICOM" && !declaredIsImage && !declaredIsPdf);

  if (!validMagic && kind !== "DICOM") {
    findings.push({
      code: "MAGIC_MISMATCH",
      label: "File signature does not match its type",
      severity: "high",
      detail: `Declared as ${mime || "unknown"}/${filename.split(".").pop() ?? "?"}, detected ${kind}. Renamed files are a common concealment technique.`,
      weight: -26,
      category: "integrity",
    });
  }

  const dimensions = kind === "JPEG" ? jpegDimensions(buf) : kind === "PNG" ? pngDimensions(buf) : null;

  if (dimensions && (dimensions.width < 200 || dimensions.height < 200)) {
    findings.push({
      code: "LOW_RESOLUTION",
      label: "Very low image resolution",
      severity: "low",
      detail: `Image is ${dimensions.width}×${dimensions.height}px — too small for a legible clinical record.`,
      weight: -8,
      category: "content",
    });
  }

  const softwareTags = extractSoftwareTags(buf);
  for (const tag of softwareTags) {
    const sig = EDITOR_SIGNATURES.find((s) => s.re.test(tag));
    if (sig) {
      findings.push({
        code: "IMAGE_EDITOR_METADATA",
        label: "Image-editing software detected",
        severity: sig.severity,
        detail: `Metadata references "${tag}", an image manipulation tool rather than a capture device or clinical system.`,
        weight: sig.weight,
        category: "metadata",
      });
    }
  }

  let trailingBytes = 0;
  if (kind === "JPEG") {
    const eoi = buf.lastIndexOf(Buffer.from([0xff, 0xd9]));
    if (eoi >= 0) trailingBytes = buf.length - (eoi + 2);
    if (trailingBytes > 512) {
      findings.push({
        code: "IMAGE_TRAILING_DATA",
        label: "Data appended after image end marker",
        severity: "high",
        detail: `${trailingBytes} bytes follow the JPEG EOI marker, which can hide embedded overlays or alternate content.`,
        weight: -20,
        category: "integrity",
      });
    }
  }

  const soiCount = kind === "JPEG" ? (buf.toString("latin1").match(/\xff\xd8\xff/g) ?? []).length : 0;
  if (soiCount > 1) {
    findings.push({
      code: "IMAGE_MULTIPLE_FRAMES",
      label: "Multiple concatenated images",
      severity: "medium",
      detail: `${soiCount} JPEG start-of-image markers found; the file may contain spliced content.`,
      weight: -14,
      category: "integrity",
    });
  }

  const dicomMeta = kind === "DICOM" ? parseDicom(buf) : {};
  const text =
    kind === "DICOM"
      ? Object.entries(dicomMeta)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n")
      : buf
          .subarray(0, Math.min(buf.length, 8192))
          .toString("latin1")
          .replace(/[^\x09\x0a\x0d\x20-\x7e]+/g, " ");

  return {
    kind,
    validMagic,
    dimensions,
    softwareTags,
    trailingBytes,
    duplicateMarkers: soiCount,
    dicomMeta,
    text,
    findings,
  };
}
