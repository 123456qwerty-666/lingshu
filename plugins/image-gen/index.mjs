/**
 * 插件: AI 绘图
 * 调用 OpenAI 兼容的图片生成 API（支持 diqiuonline Gemini 中转）
 *
 * 图片模型行为说明：
 * - 一次只生成 1 张图（n must be 1）
 * - 尺寸：1024x1024 / 512x512 / 1792x1024
 * - 耗时约 10~15 秒
 * - 返回 URL 而非 base64
 * - 超时建议 120 秒以上
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..', '..');

export function setup(ctx) {
  return {
    tools: [
      {
        name: 'generate_image',
        description: '根据文字描述生成图片。参数：prompt(描述), size(1024x1024/512x512/1792x1024), provider(可选)',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: '图片描述（中英文均可，写越具体越好）' },
            size: { type: 'string', enum: ['1024x1024', '512x512', '1792x1024'], description: '图片尺寸，默认 1024x1024' },
            provider: { type: 'string', description: '提供商 ID（默认使用全局默认）' },
          },
          required: ['prompt'],
        },
        async run(args) {
          try {
            const { generateImage, saveImageForSend } = await import('./helpers.mjs');
            const result = await generateImage(args.prompt, {
              size: args.size || '1024x1024',
              providerId: args.provider,
              onLog: (m, lvl) => ctx.log(m),
            });
            const savedPath = await saveImageForSend(result);
            return {
              success: true,
              url: result.format === 'url' ? result.data : null,
              path: savedPath,
              prompt: args.prompt,
              size: args.size || '1024x1024',
              note: '图片已生成并会由系统自动发送给对方，无需再调用发送工具',
            };
          } catch (e) {
            ctx.log(`generate_image failed: ${e.message}`);
            const msg = String(e.message || '');
            return {
              success: false,
              error: msg,
              hint: /rate limit|429|额度|quota/i.test(msg)
                ? '绘图服务被限流了，请告诉用户稍后再试'
                : /401|403|key/i.test(msg)
                  ? '绘图 API Key 无效，需要用户去 AI 配置里检查'
                  : '绘图失败，请告诉用户这次没画出来',
            };
          }
        },
      },
    ],
  };
}
