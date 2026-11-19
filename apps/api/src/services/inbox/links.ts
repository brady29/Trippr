/**
 * Links in an inbox message, and what TikTok and YouTube say about them.
 * Only the platforms' fixed public oEmbed endpoints are called (never the
 * link itself), so a message cannot make the API fetch arbitrary URLs.
 */

export interface LinkPreview {
  url: string;
  host: string;
  social: boolean;
  title: string | null;
  author: string | null;
  thumbnailUrl: string | null;
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

const SOCIAL_HOSTS = ["tiktok.com", "instagram.com", "youtube.com", "youtu.be", "x.com", "twitter.com", "facebook.com", "xiaohongshu.com", "xhslink.com"];

/** Links that never point at a place: unsubscribe footers, tracking pixels, the booking site's own pages. */
const NOISE = /unsubscribe|optout|opt-out|privacy|preferences|\/track|click\.|email\.|mailchi\.mp|list-manage|\.(png|jpe?g|gif)(\?|$)/i;

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "").replace(/^m\./, "");
  } catch {
    return "";
  }
};

export const isSocial = (host: string) => SOCIAL_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));

/** Up to `limit` distinct links from the text, social links first. */
export function findLinks(text: string, limit = 5): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.match(URL_RE) ?? []) {
    const url = raw.replace(/[.,;:!?]+$/, "");
    if (seen.has(url) || NOISE.test(url) || !hostOf(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out.sort((a, b) => Number(isSocial(hostOf(b))) - Number(isSocial(hostOf(a)))).slice(0, limit);
}

function oembedFor(url: string, host: string): string | null {
  if (host === "youtube.com" || host === "youtu.be" || host.endsWith(".youtube.com")) {
    return `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`;
  }
  if (host === "tiktok.com" || host.endsWith(".tiktok.com")) return `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
  return null;
}

async function fetchJson(url: string, timeoutMs: number): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

export async function previewLinks(urls: string[], options: { fetchPreviews: boolean; timeoutMs?: number }): Promise<LinkPreview[]> {
  return Promise.all(
    urls.map(async (url) => {
      const host = hostOf(url);
      const base: LinkPreview = { url, host, social: isSocial(host), title: null, author: null, thumbnailUrl: null };
      const endpoint = options.fetchPreviews ? oembedFor(url, host) : null;
      if (!endpoint) return base;
      const data = await fetchJson(endpoint, options.timeoutMs ?? 4000);
      if (!data) return base;
      return { ...base, title: s(data.title), author: s(data.author_name), thumbnailUrl: s(data.thumbnail_url) };
    }),
  );
}

/** Plain text from an HTML email body: drops styles and scripts, keeps link targets next to their text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => `${label} (${href}) `)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d|table)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}
