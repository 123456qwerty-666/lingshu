/**
 * 灵枢 AI 中枢 — 时间工具
 *
 * 目的：让模型「知道现在几点、这条消息什么时候发的、这条记忆是什么时候的事」。
 * 没有时间感，模型就没法理解「明天」「上周」「你上次说的」这些话。
 */
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const pad = (n) => String(n).padStart(2, '0');

function toDate(ts) {
  const n = Number(ts);
  if (!n || !Number.isFinite(n)) return new Date();
  // 微信有些地方给的是秒级时间戳
  return new Date(n < 1e12 ? n * 1000 : n);
}

/** 完整时间：2026-11-02 11:41:23 周一 */
export function formatTime(ts) {
  const d = toDate(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${WEEKDAYS[d.getDay()]}`;
}

/** 精确到分：2026-11-02 11:41 周一 */
export function formatTimeMinute(ts) {
  const d = toDate(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())} ${WEEKDAYS[d.getDay()]}`;
}

/** 只有日期：2026-11-02 周一 */
export function formatDate(ts) {
  const d = toDate(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${WEEKDAYS[d.getDay()]}`;
}

/** 相对描述：刚刚 / 12分钟前 / 3小时前 / 2天前 / 3周前 / 5个月前 */
export function relativeTime(ts, now = Date.now()) {
  const t = toDate(ts).getTime();
  const diff = now - t;
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? '前' : '后';
  const min = 60000, hour = 3600000, day = 86400000;

  if (abs < 60000) return '刚刚';
  if (abs < hour) return `${Math.floor(abs / min)}分钟${suffix}`;
  if (abs < day) return `${Math.floor(abs / hour)}小时${suffix}`;
  if (abs < day * 30) return `${Math.floor(abs / day)}天${suffix}`;
  if (abs < day * 365) return `${Math.floor(abs / (day * 30))}个月${suffix}`;
  return `${Math.floor(abs / (day * 365))}年${suffix}`;
}

/** 给记忆用的紧凑时间标注：2026-11-02 11:41 周一 · 3天前 */
export function timeLabel(ts, now = Date.now()) {
  return `${formatTimeMinute(ts)} · ${relativeTime(ts, now)}`;
}

/** 注入给模型的"现在几点"提示块 */
export function nowBlock(now = Date.now()) {
  return [
    `【当前时间】${formatTime(now)}`,
    '（下面每条对方消息末尾的「（发送时间：…）」是系统自动附加的元信息，不是对方说的话。',
    '回复时不要把时间写进正文，也不要在结尾附上时间；只有对方主动问「现在几点 / 今天几号」时才回答。）',
  ].join('\n');
}

// 模型偶尔仍会把时间尾注抄进回复里，这里做一次兜底清理
const ECHO_PATTERNS = [
  /[（(]\s*(发送|接收|对话)?\s*时间\s*[：:][^）)]*[）)]/g,
  /[（(]\s*(当前时间|现在时间)\s*[：:][^）)]*[）)]/g,
  /[（(]\s*\d{4}-\d{1,2}-\d{1,2}[^）)]*[）)]/g,
  /[（(]\s*\d{1,2}\s*[:：]\s*\d{2}\s*[^）)]{0,12}[）)]/g,
];

/**
 * 去掉回复里被模型"抄"出来的时间尾注。
 * 只删明确是时间戳的东西（带括号、符合时间格式），不动正常内容。
 */
export function stripTimeEcho(text) {
  let out = String(text || '');
  for (const re of ECHO_PATTERNS) out = out.replace(re, '');
  // 结尾只剩时间戳的一行（如 "2026-11-02 11:47 周一"）也删掉
  out = out.replace(/\n{1,}[（(【]?\s*\d{4}-\d{1,2}-\d{1,2}[^\n]*[）)】]?\s*$/, '');
  out = out.replace(/\n{1,}[（(【]?\s*\d{1,2}\s*[:：]\s*\d{2}[^\n]*[）)】]?\s*$/, '');
  // 清理掉多余空行与行尾空白
  out = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return out;
}

/** 一条用户/助手消息的时间尾注 */
export function messageStamp(ts) {
  return `\n（发送时间：${formatTime(ts)}）`;
}
