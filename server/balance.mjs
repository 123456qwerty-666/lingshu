/**
 * API 余额查询（"饭钱"）
 *
 * 目前支持 DeepSeek 的 /user/balance 接口；其他供应商没有统一的余额 API，
 * 查询会返回「查不到」，不会报错。
 *
 * 缓存 5 分钟，避免每次聊天都打一次接口。
 */
import { loadConfig } from './config.mjs';

const CACHE_MS = 5 * 60 * 1000;
const cache = new Map();   // providerId -> { at, data }

/** 大肥鱼人格的标识：personaId 或人格文本里出现「大肥鱼」 */
export function isDafeiyu(cfg, talker) {
  const chat = cfg?.chats?.[talker] || {};
  if (chat.personaId === 'dafeiyu') return true;
  const text = String(chat.persona || '');
  if (text.includes('大肥鱼')) return true;
  const global = cfg?.persona?.overrides?.[talker] || cfg?.persona?.default || '';
  return String(global).includes('大肥鱼');
}

/** 当前这个会话实际在用的提供商 */
export function activeProviderId(cfg, talker) {
  const chat = cfg?.chats?.[talker] || {};
  return chat.model?.providerId || cfg?.ai?.defaultProvider || '';
}

/**
 * 查余额。返回
 *   { ok: true, provider, currency, total, granted, toppedUp, available }
 *   { ok: false, reason }
 */
export async function checkBalance(providerId = null, { force = false } = {}) {
  const cfg = await loadConfig();
  const pid = providerId || cfg.ai?.defaultProvider;
  const provider = cfg.ai?.providers?.[pid];
  if (!provider) return { ok: false, reason: `没有这个提供商：${pid}` };
  if (!provider.apiKey) return { ok: false, reason: '这个提供商没填 API Key' };

  const hit = cache.get(pid);
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  // DeepSeek 官方余额接口
  if (/deepseek/i.test(pid) || /api\.deepseek\.com/i.test(provider.baseUrl || '')) {
    try {
      const url = String(provider.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '') + '/user/balance';
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${provider.apiKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      const raw = await r.text();
      if (!r.ok) {
        const data = { ok: false, reason: `余额查询失败 HTTP ${r.status}：${raw.slice(0, 120)}` };
        cache.set(pid, { at: Date.now(), data });
        return data;
      }
      const j = JSON.parse(raw);
      const info = (j.balance_infos || [])[0] || {};
      const num = (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };
      const data = {
        ok: true,
        provider: pid,
        available: j.is_available !== false,
        currency: info.currency || 'CNY',
        total: num(info.total_balance),
        granted: num(info.granted_balance),
        toppedUp: num(info.topped_up_balance),
        at: Date.now(),
      };
      cache.set(pid, { at: Date.now(), data });
      return data;
    } catch (e) {
      const data = { ok: false, reason: `余额查询出错：${e.message}` };
      cache.set(pid, { at: Date.now(), data });
      return data;
    }
  }

  const data = { ok: false, reason: `${pid} 没有公开的余额查询接口` };
  cache.set(pid, { at: Date.now(), data });
  return data;
}

/** 拼一句给人/AI 看的余额说明 */
export function formatBalance(b, { dafeiyu = false } = {}) {
  if (!b?.ok) return `（查不到余额：${b?.reason || '未知原因'}）`;
  const unit = b.currency === 'CNY' ? '元' : b.currency;
  const total = b.total === null ? '未知' : b.total.toFixed(2);
  const head = dafeiyu ? '饭钱' : 'API 余额';
  const parts = [`${head}还剩 ${total} ${unit}`];
  if (b.granted !== null && b.granted > 0) parts.push(`其中赠送 ${b.granted.toFixed(2)}`);
  if (b.toppedUp !== null && b.toppedUp > 0) parts.push(`充值 ${b.toppedUp.toFixed(2)}`);
  if (b.available === false) parts.push('（当前不可用，可能已欠费）');
  return parts.join('，');
}

export function clearBalanceCache() { cache.clear(); }
