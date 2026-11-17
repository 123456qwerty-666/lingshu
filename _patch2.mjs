import fs from 'node:fs';
let s = fs.readFileSync('public/index.html', 'utf8');
const old = `    box.innerHTML = msgs.map(m => {
      const out = m.role === 'assistant';
      const who = m.sender || (out ? 'AI' : '');
      const time = m.ts ? fmtTime(m.ts) : '';
      return `<div class="msg \${out ? 'out' : 'in'}">\${esc(m.content)}
        <div class="meta">\${esc(who)}\${time ? ' · ' + esc(time) : ''}</div></div>`;
    }).join('');`;

const nb = `    box.innerHTML = msgs.map(m => {
      const out = m.role === 'assistant';
      const who = m.sender || (out ? 'AI' : '');
      const time = m.ts ? fmtTime(m.ts) : '';
      // QQ 的图片/语音：后台会把本地缓存地址挂在 media 上，这里直接渲染出来
      let body;
      const md = m.media;
      if (md && md.url && md.kind === 'voice') {
        const dur = md.duration ? \`\${Number(md.duration).toFixed(1)}″\` : '';
        body = \`<div class="msg-voice"><span class="vi">🎤</span><audio controls preload="none" src="\${esc(md.url)}"></audio>\${dur ? \`<span class="hint dim">\${dur}</span>\` : ''}</div>\`;
        if (m.content && !/^\\[语音\\]/.test(m.content)) body += \`<div class="hint dim" style="margin-top:4px">\${esc(m.content)}</div>\`;
      } else if (md && md.url && (md.kind === 'image' || md.kind === 'sticker')) {
        body = \`<a href="\${esc(md.url)}" target="_blank" rel="noopener"><img class="msg-img" src="\${esc(md.url)}" loading="lazy" alt="\${md.kind === 'sticker' ? '表情' : '图片'}"></a>\`;
      } else {
        body = esc(m.content);
      }
      return \`<div class="msg \${out ? 'out' : 'in'}">\${body}
        <div class="meta">\${esc(who)}\${time ? ' · ' + esc(time) : ''}</div></div>\`;
    }).join('');`;

if (!s.includes(old)) { console.log('未匹配 QQ 渲染'); process.exit(1); }
s = s.replace(old, nb);
fs.writeFileSync('public/index.html', s);
console.log('QQ 渲染已支持图片/语音');
