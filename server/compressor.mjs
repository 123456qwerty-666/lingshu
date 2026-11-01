/**
 * 灵枢 AI 中枢 — 上下文滚动压缩
 *
 * 模型上下文按 512K 设计（config.context.maxTokens），但真正对话时不可能等它撑满：
 * 到 compressAtTokens（默认 48K）就把旧消息交给模型压成一段摘要，
 * 只保留最近 keepRecentMessages 条原文，摘要作为 system 消息常驻。
 *
 * 压缩是「有损但可控」的：摘要会保留人物、事实、约定、情绪倾向和未完成的事。
 */
import { ChatContext } from './router.mjs';
import { estimateMessagesTokens, estimateTokens } from './memory.mjs';

const SUMMARY_SYSTEM = `你是对话压缩器。把「已有摘要」和「新增对话」合并成一段新的摘要。

要求：
1. 保留：人物与称呼、关键事实、达成的约定、对方明确表达的偏好/情绪、尚未完成的事
2. 丢弃：寒暄、语气词、重复内容、机器人自己的客套话
3. 用第三人称陈述，按主题归类，不要逐句复述
4. 控制在 {{MAX}} 字以内，只输出摘要正文，不要任何前缀或解释`;

/**
 * @returns {{skipped?:string, compressed?:number, beforeTokens?:number, afterTokens?:number, summary?:string}}
 */
export async function compressContext(talker, { aiClient, config, force = false } = {}) {
  const cfg = config?.context || {};
  const keepRecent = cfg.keepRecentMessages ?? 14;
  const threshold = cfg.compressAtTokens ?? 48000;
  const maxWords = cfg.summaryMaxTokens ?? 700;

  const ctx = new ChatContext(talker);
  const before = ctx.tokens();
  // 自动模式下要求成批（≥4 条）才压缩；手动触发允许少量
  const { head, cut } = ctx.previewCompression(keepRecent, force ? 1 : 4);

  if (!head.length) return { skipped: 'too_short', beforeTokens: before };
  if (!force && before < threshold) return { skipped: 'under_threshold', beforeTokens: before, threshold };

  if (!aiClient) return { skipped: 'no_ai', beforeTokens: before };

  const oldSummary = ctx.getSummary();
  const dialog = head
    .map(m => `${m.role === 'user' ? '对方' : '我'}：${String(m.content || '').replace(/\s+/g, ' ').slice(0, 400)}`)
    .join('\n');

  let summary = '';
  try {
    const r = await aiClient.chat([
      { role: 'system', content: SUMMARY_SYSTEM.replace('{{MAX}}', String(maxWords)) },
      {
        role: 'user',
        content: [
          oldSummary ? `【已有摘要】\n${oldSummary}` : '【已有摘要】（无）',
          `【新增对话】\n${dialog}`,
        ].join('\n\n'),
      },
    ], { maxTokens: Math.max(400, Math.ceil(maxWords * 1.6)), temperature: 0.3 });
    summary = (r.content || '').trim();
  } catch (e) {
    return { skipped: 'summarize_failed', error: e.message, beforeTokens: before };
  }

  if (!summary) return { skipped: 'empty_summary', beforeTokens: before };

  ctx.dropHead(cut);
  ctx.setSummary(summary, { compressedCount: head.length, coversUpTo: Date.now() });

  const after = ctx.tokens() + estimateTokens(summary);
  return {
    compressed: head.length,
    beforeTokens: before,
    afterTokens: after,
    kept: ctx.messageCount(),
    summary,
  };
}

/** 只读：上下文用量概览 */
export function contextUsage(talker, config) {
  const ctx = new ChatContext(talker);
  const tokens = ctx.tokens() + estimateTokens(ctx.getSummary());
  const max = config?.context?.maxTokens ?? 512000;
  const threshold = config?.context?.compressAtTokens ?? 48000;
  return {
    talker,
    messages: ctx.messageCount(),
    tokens,
    maxTokens: max,
    compressAtTokens: threshold,
    usagePercent: Number(((tokens / max) * 100).toFixed(2)),
    willCompress: tokens >= threshold,
    hasSummary: Boolean(ctx.getSummary()),
    summaryTokens: estimateTokens(ctx.getSummary()),
    summaryUpdatedAt: ctx.data?.metadata?.summary?.updatedAt || 0,
    compressedCount: ctx.data?.metadata?.summary?.compressedCount || 0,
    summary: ctx.getSummary(),
  };
}
