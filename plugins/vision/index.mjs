/**
 * 插件: 图片理解 (Vision)
 * 自动将收到的图片传入模型
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..', '..');

export function setup(ctx) {
  return {
    hooks: {
      onMessage(msg) { return msg; },
    },
    tools: [
      {
        name: 'describe_image',
        description: '获取图片信息（分辨率、格式等），用于确认图片已准备好供 AI 查看。',
        parameters: {
          type: 'object',
          properties: {
            image_id: { type: 'string', description: '图片 ID（来自消息中的 images 字段）' },
            conversation_key: { type: 'string', description: '会话 key，格式 wechat:private:xxx 或 wechat:group:xxx' },
          },
          required: ['image_id', 'conversation_key'],
        },
        async run(args) {
          const { getReader } = await import(pathToFileURL(path.join(ROOT_DIR, 'server', 'wechat.mjs')).href);
          const reader = getReader();
          if (!reader) return { error: 'WeChat 未连接' };
          try {
            const imgData = await reader.getImage(args.image_id, args.conversation_key);
            return {
              success: true,
              mime: imgData.mime,
              quality: imgData.sourceQuality,
              sizeKB: Math.round(imgData.b64.length * 0.75 / 1024),
              note: '图片已就绪，AI 可直接使用',
            };
          } catch (e) {
            return { success: false, error: e.message };
          }
        },
      },
    ],
  };
}
