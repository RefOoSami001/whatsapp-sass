/**
 * Detect HTTPS image URLs in AI reply text for WhatsApp media delivery.
 * Supports both:
 * - direct links: https://host/path/file.jpg
 * - markdown links: [label](https://host/path/file.jpg)
 */
const DIRECT_IMAGE_URL_RE =
  /https:\/\/[^\s<>"')\]]+\.(?:jpg|jpeg|png|gif|webp)(?:\?[^\s<>"')\]]*)?/gi;
const MARKDOWN_IMAGE_URL_RE =
  /\[[^\]]*]\((https:\/\/[^\s<>"')\]]+\.(?:jpg|jpeg|png|gif|webp)(?:\?[^\s<>"')\]]*)?)\)/gi;

function normalizeExtractedUrl(raw: string): string {
  return raw.trim().replace(/[),.;!?]+$/g, '');
}

export function extractDirectImageUrls(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let mm: RegExpExecArray | null;
  const mdRe = new RegExp(MARKDOWN_IMAGE_URL_RE.source, MARKDOWN_IMAGE_URL_RE.flags);
  while ((mm = mdRe.exec(text)) !== null) {
    const u = normalizeExtractedUrl(mm[1] ?? '');
    if (u && !seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }

  let m: RegExpExecArray | null;
  const re = new RegExp(DIRECT_IMAGE_URL_RE.source, DIRECT_IMAGE_URL_RE.flags);
  while ((m = re.exec(text)) !== null) {
    const u = normalizeExtractedUrl(m[0] ?? '');
    if (u && !seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}

export function stripImageUrls(text: string): string {
  return text
    .replace(MARKDOWN_IMAGE_URL_RE, '')
    .replace(DIRECT_IMAGE_URL_RE, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}
