/**
 * 联网搜索 / 网页读取 的底层实现
 *
 * 设计约束：项目零第三方依赖，所以直接抓搜索引擎结果页并做轻量解析。
 * 引擎按顺序尝试，任意一个成功就返回；全失败才报错。
 *   bing（全球） → 360 → 百度
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const COMMON_HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Cache-Control': 'no-cache',
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── HTML 工具 ─────────────────────────────────────────────
export function stripTags(s) {
  return String(s || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function absolutize(url, base) {
  try { return new URL(url, base).href; } catch { return url; }
}

function isBlockedHost(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return true;
  return /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?)/.test(h);
}

function decodeBuffer(buf, contentType) {
  let charset = '';
  const fromHeader = /charset=([\w-]+)/i.exec(contentType || '');
  if (fromHeader) charset = fromHeader[1];
  if (!charset) {
    const head = buf.slice(0, 4096).toString('latin1');
    const meta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head);
    if (meta) charset = meta[1];
  }
  const label = (charset || 'utf-8').toLowerCase();
  const normalized = /gb2312|gbk|gb18030/.test(label) ? 'gbk' : label;
  try {
    return new TextDecoder(normalized, { fatal: false }).decode(buf);
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(buf);
  }
}

// ── 各引擎解析器 ──────────────────────────────────────────
function parseBing(html, limit) {
  const out = [];
  const blocks = html.split(/<li class="b_algo"/).slice(1);
  for (const block of blocks) {
    if (out.length >= limit) break;
    const link = /<h2[^>]*>[\s\S]*?<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!link) continue;
    const url = link[1];
    const title = stripTags(link[2]);
    if (!title || url.includes('bing.com')) continue;
    const snip = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    out.push({ title, url, snippet: snip ? stripTags(snip[1]).slice(0, 300) : '' });
  }
  return out;
}

function parse360(html, limit) {
  const out = [];
  const blocks = html.split(/class="res-list/).slice(1);
  for (const block of blocks) {
    if (out.length >= limit) break;
    const titleM = /<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!titleM) continue;
    const title = stripTags(titleM[1]);
    const real = /data-mdurl="([^"]+)"/i.exec(block);
    const href = /<a[^>]+href="(https?:\/\/[^"]+)"/i.exec(block);
    const url = real?.[1] || (href && !href[1].includes('so.com/link') ? href[1] : '');
    if (!title || !url) continue;
    const snip = /<p[^>]*class="res-desc"[^>]*>([\s\S]*?)<\/p>/i.exec(block)
      || /<div[^>]*class="res-desc"[^>]*>([\s\S]*?)<\/div>/i.exec(block)
      || /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    out.push({ title, url, snippet: snip ? stripTags(snip[1]).slice(0, 300) : '' });
  }
  return out;
}

function parseBaidu(html, limit) {
  const out = [];
  // 百度结果块用 mu="真实地址" 标出跳转目标，比 /link?url= 稳定
  const blocks = html.split(/<div[^>]+class="[^"]*c-container[^"]*"/).slice(1);
  for (const block of blocks) {
    if (out.length >= limit) break;
    const mu = /mu="(https?:\/\/[^"]+)"/i.exec(block);
    const h3 = /<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(block);
    if (!h3) continue;
    const anchor = /<a[^>]*>([\s\S]*?)<\/a>/i.exec(h3[1]);
    const title = stripTags(anchor ? anchor[1] : h3[1]);
    if (!title) continue;
    const href = /<a[^>]+href="(https?:\/\/[^"]+)"/i.exec(h3[1]);
    const url = mu?.[1] || (href ? href[1] : '');
    if (!url || url.includes('baidu.com')) continue;
    const snip = /<span[^>]*class="[^"]*content-right[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(block)
      || /<div[^>]*class="[^"]*c-abstract[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block)
      || /<span[^>]*class="[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(block);
    out.push({ title, url, snippet: snip ? stripTags(snip[1]).slice(0, 300) : '' });
  }
  return out;
}

const ENGINES = [
  {
    id: 'bing',
    label: 'Bing',
    url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-CN`,
    parse: parseBing,
  },
  {
    id: '360',
    label: '360搜索',
    url: (q) => `https://www.so.com/s?q=${encodeURIComponent(q)}`,
    parse: parse360,
  },
  {
    id: 'baidu',
    label: '百度',
    url: (q) => `https://www.baidu.com/s?wd=${encodeURIComponent(q)}&rn=20`,
    parse: parseBaidu,
  },
];

export const ENGINE_IDS = ENGINES.map(e => e.id);

/** 仅供离线测试用 */
export const __parseForTest = { bing: parseBing, '360': parse360, baidu: parseBaidu };

// ── 抓取 ──────────────────────────────────────────────────
export async function fetchHtml(url, { timeout = 15000 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await fetch(url, { headers: COMMON_HEADERS, signal: AbortSignal.timeout(timeout), redirect: 'follow' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      const text = decodeBuffer(buf, resp.headers.get('content-type'));
      return { text, finalUrl: resp.url || url, contentType: resp.headers.get('content-type') || '' };
    } catch (e) {
      lastErr = e;
      const retryable = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|network/i.test(e.message);
      if (!retryable || attempt === 1) break;
      await sleep(600);
    }
  }
  const reason = /fetch failed|ENOTFOUND|EAI_AGAIN/i.test(lastErr?.message || '')
    ? '网络不可达（域名解析或连接失败，可能被墙/需要代理）'
    : lastErr?.message || '未知错误';
  const err = new Error(reason);
  err.cause = lastErr;
  throw err;
}

/**
 * 联网搜索。按引擎顺序尝试，返回第一个有结果的引擎的数据。
 * @returns {{engine:string, results:Array<{title,url,snippet}>, tried:Array}}
 */
export async function webSearch(query, { limit = 5, timeout = 15000, onLog } = {}) {
  const q = String(query || '').trim();
  if (!q) throw new Error('搜索词不能为空');
  if (q.length > 200) throw new Error('搜索词过长');

  const tried = [];
  let lastErr = null;

  for (const engine of ENGINES) {
    tried.push(engine.id);
    try {
      const { text } = await fetchHtml(engine.url(q), { timeout });
      const results = dedupeResults(engine.parse(text, limit * 2)).slice(0, limit);
      if (results.length) {
        onLog?.(`${engine.label} 返回 ${results.length} 条`);
        return { engine: engine.label, engineId: engine.id, results, tried };
      }
      onLog?.(`${engine.label} 没有解析到结果，换下一个`);
    } catch (e) {
      lastErr = e;
      onLog?.(`${engine.label} 失败：${e.message}`);
    }
    await sleep(200);
  }
  throw new Error(`所有搜索源都失败了${lastErr ? `（最后一次：${lastErr.message}）` : ''}`);
}

function dedupeResults(list) {
  const seen = new Set();
  const out = [];
  for (const r of list) {
    const key = `${r.url}|${r.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

// ── 网页正文读取 ──────────────────────────────────────────
/**
 * 抓网页并提取可读正文
 * @returns {{url, title, text, truncated, contentType}}
 */
export async function fetchPage(url, { maxChars = 6000, timeout = 20000 } = {}) {
  let target;
  try { target = new URL(url); } catch { throw new Error('网址格式不正确'); }
  if (!/^https?:$/.test(target.protocol)) throw new Error('只支持 http / https');
  if (isBlockedHost(target.hostname)) throw new Error('出于安全考虑，不读取内网地址');

  let page;
  try {
    page = await fetchHtml(target.href, { timeout });
  } catch (e) {
    throw new Error(`打不开 ${target.hostname}：${e.message}`);
  }
  const { text: raw, finalUrl, contentType } = page;

  // 纯文本 / JSON 直接返回
  if (/^(text\/plain|application\/(json|xml)|text\/(markdown|csv))/i.test(contentType)) {
    const text = raw.slice(0, maxChars);
    return { url: finalUrl, title: '', text, truncated: raw.length > maxChars, contentType };
  }

  const titleM = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw);
  const title = titleM ? stripTags(titleM[1]) : '';

  // 去掉导航/页脚噪声
  let body = raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<form[\s\S]*?<\/form>/gi, ' ');

  // 优先取正文容器
  const mainM = /<article[^>]*>([\s\S]*?)<\/article>/i.exec(body)
    || /<main[^>]*>([\s\S]*?)<\/main>/i.exec(body)
    || /<div[^>]+(?:id|class)="[^"]*(?:content|article|post|markdown|rich_media_content)[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(body);
  if (mainM && stripTags(mainM[1]).length > 200) body = mainM[1];

  let text = stripTags(body);
  const truncated = text.length > maxChars;
  if (truncated) text = text.slice(0, maxChars);

  return { url: finalUrl, title, text, truncated, contentType };
}
