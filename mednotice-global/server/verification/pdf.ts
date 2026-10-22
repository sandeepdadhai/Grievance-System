import zlib from "node:zlib";
import type { Finding } from "./types.js";

export type PdfAnalysis = {
  valid: boolean;
  version: string | null;
  revisions: number;
  pageCount: number;
  producer: string | null;
  creator: string | null;
  creators: string[];
  creationDate: string | null;
  modDate: string | null;
  fonts: string[];
  fontFamilies: string[];
  embeddedFontCount: number;
  imageCount: number;
  activeContent: boolean;
  digitalSignature: boolean;
  encrypted: boolean;
  pdfa: boolean;
  text: string;
  findings: Finding[];
};

const SUSPICIOUS_PRODUCERS: Array<{ re: RegExp; note: string; weight: number; severity: Finding["severity"] }> = [
  { re: /photoshop|pixelmator|affinity photo|gimp|pixlr|facetune/i, note: "raster image editor", weight: -35, severity: "high" },
  { re: /canva|figma|illustrator|indesign|scribus/i, note: "graphic design tool", weight: -30, severity: "high" },
  { re: /ilovepdf|smallpdf|pdfescape|sejda|pdf24|pdf filler|pdffiller|pdf2go|docfly/i, note: "online PDF editing service", weight: -26, severity: "high" },
  { re: /microsoft word|google docs|libreoffice writer|pages|keynote|powerpoint/i, note: "word processor rather than a clinical records system", weight: -18, severity: "medium" },
  { re: /camscanner|scanner app|tiny scanner|adobe scan/i, note: "consumer mobile scanning application", weight: -6, severity: "low" },
];

function latin1(buf: Buffer): string {
  return buf.toString("latin1");
}

function findValue(text: string, key: string): string | null {
  const re = new RegExp(`/${key}\\s*\\(([^)]{0,200})\\)`);
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

function parsePdfDate(value: string | null): number | null {
  if (!value) return null;
  const m = value.match(/D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/);
  if (!m) return null;
  const [, y, mo = "01", d = "01", h = "00", mi = "00", s = "00"] = m;
  const ts = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  return Number.isFinite(ts) ? ts : null;
}

function unescapePdfString(s: string): string {
  return s
    .replace(/\\([nrtbf()\\])/g, (_, c: string) => ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" }[c] ?? c))
    .replace(/\\(\d{1,3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)));
}

/** Inflate all FlateDecode streams (content streams and object streams). */
function inflateStreams(buf: Buffer): string[] {
  const out: string[] = [];
  const raw = latin1(buf);
  let idx = 0;
  let guard = 0;
  while ((idx = raw.indexOf("stream", idx)) !== -1 && guard < 400) {
    guard += 1;
    let start = idx + "stream".length;
    if (raw[start] === "\r") start += 1;
    if (raw[start] === "\n") start += 1;
    const end = raw.indexOf("endstream", start);
    if (end === -1) break;
    const slice = buf.subarray(start, end);
    try {
      out.push(zlib.inflateSync(slice).toString("latin1"));
    } catch {
      try {
        out.push(zlib.inflateRawSync(slice).toString("latin1"));
      } catch {
        /* stream is not flate-encoded; skip */
      }
    }
    idx = end + "endstream".length;
  }
  return out;
}

function textFromContentStream(content: string): string[] {
  const chunks: string[] = [];
  const tjRe = /\(((?:\\.|[^\\)])*)\)\s*Tj/g;
  const tjArrayRe = /\[((?:[^\]]|\\.)*)\]\s*TJ/g;
  const hexRe = /<([0-9A-Fa-f\s]{4,})>\s*Tj/g;
  let m: RegExpExecArray | null;
  while ((m = tjRe.exec(content))) chunks.push(unescapePdfString(m[1]));
  while ((m = tjArrayRe.exec(content))) {
    const inner = m[1];
    const parts = inner.match(/\(((?:\\.|[^\\)])*)\)/g) ?? [];
    chunks.push(parts.map((p) => unescapePdfString(p.slice(1, -1))).join(""));
  }
  while ((m = hexRe.exec(content))) {
    const hex = m[1].replace(/\s+/g, "");
    const bytes: number[] = [];
    for (let i = 0; i < hex.length - 1; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
    const decoded = Buffer.from(bytes).toString("utf16le");
    if (/[\x20-\x7E]{3,}/.test(decoded)) chunks.push(decoded);
  }
  return chunks;
}

export function extractPdfText(buf: Buffer, raw: string): string {
  const parts = inflateStreams(buf).flatMap(textFromContentStream);
  // Uncompressed content streams: extract text operators from the file body too.
  if (parts.join("").length < 40) parts.push(...textFromContentStream(raw));
  const text = parts
    .join("\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\u0000/g, "")
    .trim();
  return text.slice(0, 200_000);
}

export function analyzePdf(buf: Buffer, rawOverride?: string): PdfAnalysis {
  const raw = rawOverride ?? latin1(buf);
  const findings: Finding[] = [];
  const header = raw.slice(0, 1024);
  const valid = header.includes("%PDF-");
  const version = valid ? (header.match(/%PDF-(\d\.\d)/)?.[1] ?? null) : null;

  if (!valid) {
    findings.push({
      code: "PDF_HEADER_INVALID",
      label: "Invalid PDF header",
      severity: "critical",
      detail: "File does not begin with a %PDF- header; extension and content disagree.",
      weight: -45,
      category: "integrity",
    });
  }

  const eofCount = (raw.match(/%%EOF/g) ?? []).length;
  const xrefCount = (raw.match(/startxref/g) ?? []).length;
  const revisions = Math.max(0, eofCount - 1);

  if (revisions > 0) {
    findings.push({
      code: "PDF_INCREMENTAL_UPDATES",
      label: `${revisions + 1} incremental revisions detected`,
      severity: revisions >= 2 ? "high" : "medium",
      detail: `The document contains ${xrefCount} cross-reference sections, meaning it was saved/edited after issuance. Clinical exports are normally written once.`,
      weight: revisions >= 2 ? -24 : -12,
      category: "integrity",
    });
  }

  const pageCount = new Set((raw.match(/\/Type\s*\/Page[^s]/g) ?? []).map((_, i) => i)).size;
  const producer = findValue(raw, "Producer");
  const creator = findValue(raw, "Creator");
  const creators = [producer, creator].filter((v): v is string => Boolean(v));
  const creationDate = findValue(raw, "CreationDate");
  const modDate = findValue(raw, "ModDate");
  const createdTs = parsePdfDate(creationDate);
  const modifiedTs = parsePdfDate(modDate);

  if (creationDate && createdTs === null) {
    findings.push({
      code: "PDF_DATE_MALFORMED",
      label: "Malformed creation timestamp",
      severity: "medium",
      detail: `CreationDate "${creationDate}" is not a valid PDF date.`,
      weight: -10,
      category: "metadata",
    });
  }
  if (createdTs !== null && modifiedTs !== null && modifiedTs < createdTs) {
    findings.push({
      code: "PDF_MOD_BEFORE_CREATED",
      label: "Modification predates creation",
      severity: "high",
      detail: "ModDate is earlier than CreationDate, which indicates metadata manipulation.",
      weight: -22,
      category: "metadata",
    });
  }

  for (const p of SUSPICIOUS_PRODUCERS) {
    const hit = creators.find((c) => p.re.test(c));
    if (hit) {
      findings.push({
        code: "PDF_PRODUCER_MISMATCH",
        label: "Non-clinical authoring software",
        severity: p.severity,
        detail: `Document metadata names "${hit}" (${p.note}). Hospital record exports do not originate from this class of tool.`,
        weight: p.weight,
        category: "metadata",
      });
    }
  }

  const brand = (value: string) => value.toLowerCase().split(/[\s/]/)[0];
  if (creator && producer && brand(creator) !== brand(producer)) {
    findings.push({
      code: "PDF_DUAL_TOOLCHAIN",
      label: "Conflicting producer and creator",
      severity: "low",
      detail: `Producer "${producer}" and Creator "${creator}" describe different toolchains.`,
      weight: -5,
      category: "metadata",
    });
  }

  const fontMatches = [...raw.matchAll(/\/BaseFont\s*\/([A-Za-z0-9+,\-_.]+)/g)].map((m) => m[1].replace(/^[A-Z]{6}\+/, ""));
  const fonts = [...new Set(fontMatches)];
  const fontFamilies = [...new Set(fonts.map((f) => f.split(/[-,]/)[0].replace(/MT$|PSMT$|Std$|Pro$/i, "")))];
  const embeddedFontCount = (raw.match(/\/FontFile[23]?\s/g) ?? []).length;

  if (fontFamilies.length >= 5) {
    findings.push({
      code: "PDF_FONT_FRAGMENTATION",
      label: `${fontFamilies.length} distinct font families`,
      severity: "medium",
      detail: `Fragmented typography (${fontFamilies.slice(0, 6).join(", ")}) is characteristic of pasted-in or reassembled text.`,
      weight: -14,
      category: "content",
    });
  }
  if (fontFamilies.some((f) => /comic|handwriting|brush|script|cursive/i.test(f))) {
    findings.push({
      code: "PDF_DECORATIVE_FONT",
      label: "Decorative typeface in clinical record",
      severity: "medium",
      detail: "A decorative or handwriting font is used in a document presented as a clinical record.",
      weight: -12,
      category: "content",
    });
  }
  if (fonts.length > 1 && embeddedFontCount === 0) {
    findings.push({
      code: "PDF_FONTS_NOT_EMBEDDED",
      label: "Fonts are not embedded",
      severity: "low",
      detail: `No embedded font programs found across ${fonts.length} fonts; rendering and origin cannot be confirmed.`,
      weight: -5,
      category: "integrity",
    });
  }

  const imageCount = (raw.match(/\/Subtype\s*\/Image/g) ?? []).length;
  const activeContent = /\/JavaScript|\/JS\s*[<(\[]|\/OpenAction|\/Launch|\/EmbeddedFile|\/RichMedia/.test(raw);
  if (activeContent) {
    findings.push({
      code: "PDF_ACTIVE_CONTENT",
      label: "Active content present",
      severity: "high",
      detail: "Embedded JavaScript, launch actions, or embedded files were found in a submitted medical document.",
      weight: -20,
      category: "integrity",
    });
  }

  const digitalSignature = /\/ByteRange\s*\[/.test(raw) && /\/Type\s*\/Sig/.test(raw);
  if (digitalSignature) {
    findings.push({
      code: "PDF_SIGNED",
      label: "Digital signature container present",
      severity: "info",
      detail: "A cryptographic signature dictionary is present (signature validity requires certificate-chain validation).",
      weight: 8,
      category: "integrity",
    });
  }

  const encrypted = /\/Encrypt\s+\d+\s+\d+\s+R/.test(raw);
  const pdfa = /pdfaid:part|PDF\/A/.test(raw);

  const text = extractPdfText(buf, raw);
  const hasTextLayer = text.replace(/\s/g, "").length >= 30;
  if (!hasTextLayer && imageCount > 0) {
    findings.push({
      code: "PDF_SCANNED_IMAGE",
      label: "Scanned image without text layer",
      severity: "info",
      detail: "Document appears to be a scan. Field extraction relies on OCR metadata reported by the uploader.",
      weight: 0,
      category: "content",
    });
  }

  return {
    valid,
    version,
    revisions,
    pageCount,
    producer,
    creator,
    creators,
    creationDate,
    modDate,
    fonts,
    fontFamilies,
    embeddedFontCount,
    imageCount,
    activeContent,
    digitalSignature,
    encrypted,
    pdfa,
    text,
    findings,
  };
}
