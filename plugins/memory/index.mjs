/**
 * 插件: 记忆（灵枢记忆系统的模型侧接口）
 *
 * 真正的存储与遗忘逻辑在 server/memory.mjs：
 * - 会话级记忆 + 群成员专属记忆
 * - 遗忘曲线、自动打标签、压缩归档
 *
 * 这里只提供让模型主动读写的工具，作用域跟随当前聊天/说话人。
 */
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..', '..');

async function mem() {
  return import(pathToFileURL(path.join(ROOT_DIR, 'server', 'memory.mjs')).href);
}
async function cfgMod() {
  return import(pathToFileURL(path.join(ROOT_DIR, 'server', 'config.mjs')).href);
}

function scopeOf(runtime = {}) {
  return {
    talker: runtime.talker || '',
    memberKey: runtime.senderWxid || null,
    memberName: runtime.senderName || '',
  };
}

export function setup(ctx) {
  return {
    tools: [
      {
        name: 'remember',
        description: '把值得长期记住的信息写进记忆。参数：text(陈述句)，importance(0~1)，kind(fact/preference/event/profile/relation)，tags(标签数组)',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '要记住的内容，如「喜欢喝美式，不加糖」' },
            importance: { type: 'number', description: '重要度 0~1；身份/偏好/约定给 0.8+，琐事给 0.2' },
            kind: { type: 'string', enum: ['fact', 'preference', 'event', 'profile', 'relation'] },
            tags: { type: 'array', items: { type: 'string' }, description: '标签，如 ["爱好","饮食"]' },
          },
          required: ['text'],
        },
        async run(args, runtime) {
          const { addMemories } = await mem();
          const { talker, memberKey, memberName } = scopeOf(runtime);
          if (!talker) return { success: false, error: '当前没有会话上下文' };
          const added = addMemories(talker, [{
            text: args.text,
            importance: args.importance ?? 0.7,
            kind: args.kind || 'fact',
            tags: args.tags || [],
            source: 'tool',
          }], { memberKey, memberName });
          ctx.log(`remember → ${talker}${memberKey ? '/' + memberName : ''}: ${String(args.text).slice(0, 30)}`);
          return { success: true, count: added.length, stored: added.map(a => a.text) };
        },
      },
      {
        name: 'recall',
        description: '在记忆里搜索相关旧事。参数：query(关键词或问题)',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
        async run(args, runtime) {
          const { searchMemories } = await mem();
          const { getConfig } = await cfgMod();
          const { talker, memberKey } = scopeOf(runtime);
          if (!talker) return { success: false, error: '当前没有会话上下文' };
          const cfg = await getConfig();
          const items = searchMemories(talker, { query: args.query, memberKey, limit: 12, cfg, touch: true });
          return {
            success: true,
            count: items.length,
            results: items.map(m => ({
              text: m.text,
              tags: m.tags,
              importance: Number(Number(m.importance).toFixed(2)),
              scope: m._scope === 'member' ? `成员:${m._memberName || ''}` : '本聊天',
              retention: Number(Number(m._retention ?? 1).toFixed(2)),
            })),
          };
        },
      },
      {
        name: 'list_memories',
        description: '列出当前聊天（群聊时含说话人专属）记得的事，按重要度排序',
        parameters: { type: 'object', properties: {} },
        async run(args, runtime) {
          const { getScopeDetail } = await mem();
          const { talker, memberKey } = scopeOf(runtime);
          if (!talker) return { success: false, error: '当前没有会话上下文' };
          const d = getScopeDetail(talker);
          const chat = [...d.chat].sort((a, b) => b.importance - a.importance).slice(0, 20);
          const memberMem = memberKey && d.members[memberKey]
            ? [...d.members[memberKey].memories].sort((a, b) => b.importance - a.importance).slice(0, 20)
            : [];
          return {
            success: true,
            chat: chat.map(m => ({ text: m.text, label: m.label, tags: m.tags })),
            member: memberMem.map(m => ({ text: m.text, label: m.label, tags: m.tags })),
            memberName: memberKey ? (d.members[memberKey]?.name || '') : '',
          };
        },
      },
      {
        name: 'forget',
        description: '忘掉某条记忆（按内容模糊匹配）。参数：text(要忘记的内容片段)',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
        async run(args, runtime) {
          const { searchMemories, deleteMemory } = await mem();
          const { getConfig } = await cfgMod();
          const { talker, memberKey } = scopeOf(runtime);
          if (!talker) return { success: false, error: '当前没有会话上下文' };
          const cfg = await getConfig();
          const hits = searchMemories(talker, { query: args.text, memberKey, limit: 5, cfg });
          const target = hits.find(h => h.text.includes(String(args.text).slice(0, 8))) || hits[0];
          if (!target) return { success: false, error: '没找到相关记忆' };
          deleteMemory(talker, target.id, { memberKey: target._scope === 'member' ? target._member : null });
          ctx.log(`forget: ${target.text.slice(0, 30)}`);
          return { success: true, forgotten: target.text };
        },
      },
    ],
  };
}
