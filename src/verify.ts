export type PreviewCheck =
  | { ok: true; status: number; url: string }
  | { ok: false; kind: "protected" | "http" | "unreachable"; status?: number; url: string; detail: string };

type Fetch = typeof fetch;

const LOGIN_WALL = /vercel\.com\/(sso|login)|netlify\.com\/.*login|\/_vercel\/sso|accounts\.google\.com/i;

/**
 * Request the preview the way a visitor would and say what came back. A
 * redirect to the host's login page is reported as `protected`, not as a pass:
 * the deploy exists, but nobody has seen the page it serves, and "deployed" is
 * a claim about the page.
 */
export async function checkPreview(base: string, path: string, fetchImpl: Fetch = fetch): Promise<PreviewCheck> {
  const url = new URL(path, base.endsWith("/") ? base : `${base}/`).toString();
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    let res: Response;
    try {
      res = await fetchImpl(current, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
    } catch (e) {
      return { ok: false, kind: "unreachable", url, detail: (e as Error).message };
    }
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      const next = new URL(loc, current).toString();
      if (LOGIN_WALL.test(next)) {
        return { ok: false, kind: "protected", status: res.status, url, detail: `redirects to a login page (${new URL(next).host}): turn off preview protection or add a bypass token to verify content` };
      }
      current = next;
      continue;
    }
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, url };
    return { ok: false, kind: "http", status: res.status, url, detail: `answered HTTP ${res.status}` };
  }
  return { ok: false, kind: "http", url, detail: "too many redirects" };
}
