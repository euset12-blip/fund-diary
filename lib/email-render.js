/**
 * 邮件 HTML 渲染 + AI 分歧解析
 *
 * 纯函数模块：不读文件、不发网络、不引策略/数据层。
 * 输入数据 → 输出 HTML 字符串或解析结果。
 */

// ═══════════════════════════════════════════════════════════════
// 邮件 HTML 样式常量（_ivory 风格：浅色专业金融主题）
// ═══════════════════════════════════════════════════════════════
const EMAIL_CSS = {
  up: '#ef4444', upBg: '#fef2f2',
  down: '#10b981', downBg: '#ecfdf5',
  warn: '#f59e0b', warnBg: '#fffbeb',
  info: '#3b82f6', infoBg: '#eff6ff',
  primary: '#1677ff',
  text: '#1f2937', text2: '#6b7280', text3: '#9ca3af',
  bg: '#f5f7fa', cardBg: '#ffffff',
  border: '#e5e7eb',
};

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 解析纯文本报告为结构化段落，输出卡片式 HTML */
function textToEmailHtml(text) {
  // 去除 ANSI 颜色/格式码，避免干扰标题检测
  const cleanText = text.replace(/\x1b\[[0-9;]*m/g, '');
  const lines = cleanText.split('\n');
  const blocks = [];
  let current = null;
  let inHoldingsTable = false;
  let holdingsHeader = null;
  let holdingsRows = [];

  const SECTION_MAP = [
    { re: /🚨\s*(清仓|止损)/, type: 'stop_loss',   color: '#ef4444', bg: '#fef2f2', icon: '!' },
    { re: /🟠\s*(保护性止盈|保护止盈)/, type: 'profit_protect', color: '#f59e0b', bg: '#fffbeb', icon: '⬆' },
    { re: /🟡\s*(首次破位|止盈提醒)/, type: 'warn', color: '#f59e0b', bg: '#fffbeb', icon: '·' },
    { re: /🟢\s*(买入|加仓)/, type: 'buy',     color: '#10b981', bg: '#ecfdf5', icon: '+' },
    { re: /📊\s*大盘/, type: 'market',  color: '#3b82f6', bg: '#eff6ff', icon: '📊' },
    { re: /📋\s*全部持仓/, type: 'holdings', color: '#1f2937', bg: '#fafbfc', icon: '📋' },
    { re: /📌\s*总结/, type: 'summary', color: '#1f2937', bg: '#fafbfc', icon: '📌' },
  ];

  function flushBlock() {
    if (!current || current.lines.length === 0) return;
    const title = current.title || '';
    let sec = { type: 'text', color: '#1f2937', bg: '#ffffff', icon: '' };
    for (const m of SECTION_MAP) {
      if (m.re.test(title)) { sec = m; break; }
    }
    current.type = sec.type;
    current.color = sec.color;
    current.bg = sec.bg;
    current.icon = sec.icon;
    blocks.push(current);
    current = null;
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();

    if (/^[═━]{3,}$/.test(trimmed) || /^[━]{3,}$/.test(trimmed)) {
      flushBlock();
      continue;
    }

    if (trimmed === '') {
      if (inHoldingsTable) { inHoldingsTable = false; }
      continue;
    }

    const isTitle = !raw.startsWith('  ') && !raw.startsWith('\t') &&
                    (trimmed.startsWith('🚨') || trimmed.startsWith('🟠') ||
                     trimmed.startsWith('🟡') || trimmed.startsWith('🟢') ||
                     trimmed.startsWith('📊') || trimmed.startsWith('📋') ||
                     trimmed.startsWith('📌') || trimmed.startsWith('🤖') ||
                     trimmed.startsWith('❌') || trimmed.startsWith('✅') ||
                     trimmed.startsWith('⚠️') || trimmed.startsWith('💰'));

    if (isTitle && !raw.startsWith('  ')) {
      flushBlock();
      current = { title: trimmed, lines: [] };
      if (/📋/.test(trimmed)) {
        inHoldingsTable = true;
        holdingsRows = [];
        holdingsHeader = null;
      }
      continue;
    }

    if (inHoldingsTable) {
      if (!holdingsHeader && trimmed.includes('基金简称') && trimmed.includes('估值')) {
        holdingsHeader = trimmed;
        continue;
      }
      if (trimmed.startsWith('─') || trimmed.startsWith('┈')) continue;
      if (raw.startsWith('  ') && trimmed.length > 10) {
        holdingsRows.push(trimmed);
        continue;
      }
      if (!raw.startsWith('  ') && holdingsRows.length > 0) {
        inHoldingsTable = false;
      }
    }

    if (!current) {
      current = { title: '', lines: [] };
    }
    current.lines.push(escHtml(trimmed));
  }
  flushBlock();

  const html = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'market':
        html.push(renderMarketBlock(block));
        break;
      case 'stop_loss':
        html.push(renderActionBlock(block, '止损指令'));
        break;
      case 'profit_protect':
        html.push(renderActionBlock(block, '保护性止盈'));
        break;
      case 'warn':
        html.push(renderActionBlock(block, '观察/止盈'));
        break;
      case 'buy':
        html.push(renderActionBlock(block, '买入加仓'));
        break;
      case 'holdings':
        html.push(renderHoldingsBlock(holdingsRows, block));
        break;
      case 'summary':
        html.push(renderSummaryBlock(block));
        break;
      default:
        html.push(renderTextBlock(block));
    }
  }

  return html.join('\n');
}

/** 大盘快照 — 横向指标卡 */
function renderMarketBlock(block) {
  const items = [];
  for (const line of block.lines) {
    const m = line.match(/(.+?):\s*([\d.]+)\s*([+-][\d.]+)%/);
    if (m) {
      const up = m[3].startsWith('+');
      items.push(`
        <td style="background:${EMAIL_CSS.cardBg};border-radius:8px;padding:10px 12px;text-align:center;border:1px solid ${EMAIL_CSS.border};${up?'border-top:3px solid '+EMAIL_CSS.up:'border-top:3px solid '+EMAIL_CSS.down}">
          <div style="font-size:11px;color:${EMAIL_CSS.text2};margin-bottom:4px">${escHtml(m[1])}</div>
          <div style="font-size:16px;font-weight:700;color:${up?EMAIL_CSS.up:EMAIL_CSS.down}">${m[2]}</div>
          <div style="font-size:12px;font-weight:600;color:${up?EMAIL_CSS.up:EMAIL_CSS.down}">${m[3]}%</div>
        </td>`);
    }
  }
  let alertHtml = '';
  for (const line of block.lines) {
    if (line.includes('暴跌') || line.includes('暂停')) {
      alertHtml = `<div style="margin-top:10px;padding:10px 14px;background:${EMAIL_CSS.upBg};border-radius:8px;border-left:4px solid ${EMAIL_CSS.up};font-size:13px;font-weight:600;color:${EMAIL_CSS.up}">${line}</div>`;
    } else if (line.includes('走弱') || line.includes('偏暖')) {
      alertHtml = `<div style="margin-top:10px;padding:10px 14px;background:${EMAIL_CSS.warnBg};border-radius:8px;border-left:4px solid ${EMAIL_CSS.warn};font-size:13px;color:${EMAIL_CSS.text}">${line}</div>`;
    }
  }

  if (items.length === 0) return '';
  const cols = Math.min(items.length, 4);
  return `
    <div style="margin:14px 0">
      <div style="font-size:13px;font-weight:700;color:${EMAIL_CSS.text};margin-bottom:8px;display:flex;align-items:center;gap:4px">
        <span style="width:3px;height:14px;border-radius:2px;background:${EMAIL_CSS.primary};display:inline-block"></span>
        大盘快照
      </div>
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="table-layout:fixed">
        <tr>${items.join('')}</tr>
      </table>
      ${alertHtml}
    </div>`;
}

/** 操作指令卡片（止损/止盈/买入） */
function renderActionBlock(block, label) {
  const lines = block.lines;
  const funds = [];
  let cur = null;
  for (const line of lines) {
    const t = line.trim();
    const nameMatch = t.match(/^[❌✅⚠️💰]\s*(.+?)\s*\((\d{6})\)/);
    if (nameMatch) {
      if (cur) funds.push(cur);
      cur = { name: nameMatch[1], code: nameMatch[2], meta: [] };
    } else if (cur && t.startsWith('→')) {
      cur.instruction = t.replace(/^→\s*/, '');
    } else if (cur) {
      if (!/^[━═─]+$/.test(t) && t.length > 2) {
        cur.meta.push(t);
      }
    }
  }
  if (cur) funds.push(cur);

  if (funds.length === 0) return '';

  const cards = funds.map(f => {
    const metaRows = f.meta.map(m => {
      const hl = m
        .replace(/估值:\s*([\d.]+)/, '估值: <b>$1</b>')
        .replace(/MA\d+:\s*([\d.]+)/g, 'MA: <b>$1</b>')
        .replace(/盈亏:\s*(.*)/, '盈亏: <b>$1</b>')
        .replace(/盈利:\s*(.*)/, '盈利: <b>$1</b>')
        .replace(/偏离.*?:\s*([+-][\d.]+%)/g, '偏离: <b>$1</b>');
      return `<div style="font-size:12px;color:${EMAIL_CSS.text2};line-height:1.6">${hl}</div>`;
    }).join('');

    return `
      <div style="background:${EMAIL_CSS.cardBg};border-radius:10px;padding:14px;margin-bottom:8px;border-left:4px solid ${block.color};box-shadow:0 1px 3px rgba(0,0,0,0.06)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
          <span style="font-size:14px;font-weight:700;color:${EMAIL_CSS.text}">${escHtml(f.name)}</span>
          <span style="font-size:10px;color:${EMAIL_CSS.text3}">${f.code}</span>
        </div>
        ${metaRows}
        ${f.instruction ? `<div style="margin-top:8px;padding:6px 10px;background:${block.bg};border-radius:6px;font-size:13px;font-weight:600;color:${block.color}">→ ${escHtml(f.instruction)}</div>` : ''}
      </div>`;
  }).join('');

  return `
    <div style="margin:14px 0">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <span style="font-size:13px;font-weight:700;color:${EMAIL_CSS.text};display:flex;align-items:center;gap:4px">
          <span style="width:3px;height:14px;border-radius:2px;background:${block.color};display:inline-block"></span>
          ${block.title}
        </span>
        <span style="font-size:11px;font-weight:600;padding:2px 8px;border-radius:10px;background:${block.bg};color:${block.color}">${funds.length} 只</span>
      </div>
      ${cards}
    </div>`;
}

/** 持仓表格 → 响应式卡片列表 */
function renderHoldingsBlock(rows, block) {
  if (rows.length === 0) return '';

  const cards = rows.map(row => {
    const cols = row.split(/\s{2,}/).filter(Boolean);
    if (cols.length < 4) {
      return `<div style="font-size:11px;color:${EMAIL_CSS.text3};padding:6px 0">${escHtml(row)}</div>`;
    }

    const name = cols[0] || '';
    const price = cols[1] || '--';
    const dayChg = cols[2] || '--';
    const devMA = cols[3] || '--';
    const alignment = cols[4] || '--';
    const action = cols[5] || '--';

    let actionColor = EMAIL_CSS.text2;
    let cardBorder = EMAIL_CSS.border;
    if (action.includes('止损')) { actionColor = EMAIL_CSS.up; cardBorder = EMAIL_CSS.up; }
    else if (action.includes('保护止盈') || action.includes('止盈')) { actionColor = EMAIL_CSS.warn; cardBorder = EMAIL_CSS.warn; }
    else if (action.includes('买入') || action.includes('持有')) { actionColor = EMAIL_CSS.down; cardBorder = EMAIL_CSS.down; }
    else if (action.includes('观察') || action.includes('观望')) { actionColor = EMAIL_CSS.warn; cardBorder = EMAIL_CSS.warn; }

    let alignColor = EMAIL_CSS.text2;
    if (alignment.includes('多头')) alignColor = EMAIL_CSS.up;
    else if (alignment.includes('空头')) alignColor = EMAIL_CSS.down;

    const devUp = devMA.startsWith('+');
    const devColor = devUp ? EMAIL_CSS.up : EMAIL_CSS.down;

    return `
      <div style="background:${EMAIL_CSS.cardBg};border-radius:8px;padding:10px 12px;margin-bottom:4px;border-left:3px solid ${cardBorder};box-shadow:0 1px 2px rgba(0,0,0,0.04)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
          <span style="font-size:13px;font-weight:600;color:${EMAIL_CSS.text};max-width:55%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${escHtml(name)}</span>
          <span style="font-size:10px;font-weight:700;padding:1px 6px;border-radius:4px;background:${actionColor}15;color:${actionColor}">${escHtml(action)}</span>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;font-size:11px">
          <span style="color:${EMAIL_CSS.text3}">净值 <b style="color:${EMAIL_CSS.text}">${escHtml(price)}</b></span>
          <span style="color:${EMAIL_CSS.text3}">日变 <b>${escHtml(dayChg)}</b></span>
          <span style="color:${EMAIL_CSS.text3}">vsMA20 <b style="color:${devColor}">${escHtml(devMA)}</b></span>
          <span style="color:${EMAIL_CSS.text3}">均线 <b style="color:${alignColor}">${escHtml(alignment)}</b></span>
        </div>
      </div>`;
  }).join('');

  return `
    <div style="margin:14px 0">
      <div style="font-size:13px;font-weight:700;color:${EMAIL_CSS.text};margin-bottom:8px;display:flex;align-items:center;gap:4px">
        <span style="width:3px;height:14px;border-radius:2px;background:${EMAIL_CSS.primary};display:inline-block"></span>
        全部持仓速览
      </div>
      ${cards}
    </div>`;
}

/** 总结块 */
function renderSummaryBlock(block) {
  const text = block.lines.join('<br>');
  return `
    <div style="margin:14px 0;padding:14px 16px;background:${EMAIL_CSS.infoBg};border-radius:10px;border:1px solid ${EMAIL_CSS.info}20">
      <div style="font-size:13px;font-weight:700;color:${EMAIL_CSS.info};margin-bottom:6px">📌 操作总结</div>
      <div style="font-size:13px;color:${EMAIL_CSS.text};line-height:1.6">${text}</div>
    </div>`;
}

/** 纯文本块（免责声明等） */
function renderTextBlock(block) {
  const raw = block.lines.join('\n');
  const isDisclaimer = raw.includes('免责') || raw.includes('投资有风险');

  // AI 解读块需要 Markdown → HTML 转换，免责声明保持纯文本
  const html = isDisclaimer
    ? raw.replace(/\n/g, '<br>')
    : mdToHtml(raw);

  return `
    <div style="margin:10px 0;padding:${isDisclaimer ? '10px 14px' : '14px 16px'};font-size:${isDisclaimer ? '11px' : '14px'};color:${isDisclaimer ? EMAIL_CSS.text3 : EMAIL_CSS.text};line-height:1.8;${isDisclaimer ? 'background:' + EMAIL_CSS.bg + ';border-radius:8px;text-align:center' : 'background:' + EMAIL_CSS.cardBg + ';border-radius:10px;border:1px solid ' + EMAIL_CSS.border}">
      ${html}
    </div>`;
}

/**
 * 轻量 Markdown → HTML（只处理 AI 解读用到的子集）
 */
function mdToHtml(md) {
  // 注意：输入已由 textToEmailHtml 的 escHtml 转义过，这里不再重复转义
  let html = md
    // 标题 ## → h3
    .replace(/^## (.+)$/gm, '<h3 style="margin:16px 0 8px;font-size:15px;color:' + EMAIL_CSS.text + ';border-bottom:1px solid ' + EMAIL_CSS.border + ';padding-bottom:6px">$1</h3>')
    // 粗体 **text**
    .replace(/\*\*(.+?)\*\*/g, '<strong style="color:' + EMAIL_CSS.text + '">$1</strong>')
    // 列表项 - text
    .replace(/^- (.+)$/gm, '<li style="margin:4px 0;padding-left:4px">$1</li>')
    // 行内代码
    .replace(/`([^`]+)`/g, '<code style="background:#f1f5f9;padding:1px 5px;border-radius:3px;font-size:12px">$1</code>')
    // 段落间距
    .replace(/\n\n/g, '<br><br>')
    .replace(/\n/g, '<br>');

  // 把连续的 <li> 包进 <ul>（先合并再包裹）
  html = html.replace(/((?:<li[^>]*>[\s\S]*?<\/li><br>)+)/g, (match) => {
    return '<ul style="margin:8px 0;padding-left:20px">' + match.replace(/<br>$/, '') + '</ul>';
  });

  return html;
}

/**
 * 从 AI 解读文本中提取争议列表
 * @returns {Array<{code, name, algoSignal, aiVerdict, reason}>}
 */
function parseDisputes(aiText) {
  if (!aiText) return [];
  const m = aiText.match(/===DISPUTE===\n([\s\S]*?)\n===END===/);
  if (!m || m[1].trim() === 'NONE') return [];
  return m[1].trim().split('\n').filter(Boolean).map(line => {
    const parts = line.split('|');
    return {
      code: parts[0]?.trim() || '',
      name: parts[1]?.trim() || '',
      algoSignal: parts[2]?.trim() || '',
      aiVerdict: parts[3]?.trim() || '',
      reason: parts[4]?.trim() || '',
    };
  });
}

/** 从 AI 文本中剥离争议标记，返回干净的解读正文 */
function stripDisputeMarkers(aiText) {
  if (!aiText) return '';
  return aiText.replace(/===DISPUTE===[\s\S]*?===END===/g, '').trim();
}

module.exports = {
  EMAIL_CSS,
  escHtml,
  textToEmailHtml,
  renderMarketBlock,
  renderActionBlock,
  renderHoldingsBlock,
  renderSummaryBlock,
  renderTextBlock,
  parseDisputes,
  stripDisputeMarkers,
  mdToHtml,
};
