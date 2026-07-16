/**
 * 邮件发送服务
 *
 * 依赖：nodemailer + email-render.js
 * 不引策略/数据层/养基宝。
 */

let nodemailer = null;
try {
  nodemailer = require('nodemailer');
} catch (e) {
  // 邮件功能不可用，sendEmailNotification 会优雅跳过
}

const {
  EMAIL_CSS, escHtml, textToEmailHtml, parseDisputes,
} = require('./email-render.js');

let _emailConfig = null;
let _dashboardUrl = null;
let _log = null;

/** 初始化邮件服务（由 fund-assistant-app.js 调用一次） */
function initEmailService({ emailConfig, dashboardUrl, log } = {}) {
  _emailConfig = emailConfig || {};
  _dashboardUrl = dashboardUrl || '';
  _log = log || { info: console.log, error: console.error };
}

async function sendEmailNotification(textContent, aiInsightText) {
  if (!nodemailer) {
    console.log('📧 邮件功能未启用（nodemailer 未安装），跳过推送');
    return;
  }
  if (!_emailConfig || !_emailConfig.enabled) {
    console.log('📧 邮件推送未启用，跳过');
    return;
  }

  try {
    const transporter = nodemailer.createTransport({
      host: _emailConfig.host,
      port: _emailConfig.port,
      secure: true,
      auth: { user: _emailConfig.user, pass: _emailConfig.pass },
    });

    const disputes = aiInsightText ? parseDisputes(aiInsightText) : [];
    const htmlBody = textToEmailHtml(textContent);
    const today = new Date().toLocaleDateString('zh-CN');
    const weekday = ['周日','周一','周二','周三','周四','周五','周六'][new Date().getDay()];
    const timeStr = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

    // ─── 争议案例卡片 ───
    let disputeHtml = '';
    if (disputes.length > 0) {
      const cards = disputes.map(d => `
        <div style="background:#fff;border-radius:10px;padding:12px 14px;margin-bottom:6px;border-left:4px solid #f59e0b;box-shadow:0 1px 3px rgba(0,0,0,0.05)">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
            <span style="font-size:14px;font-weight:700;color:#1f2937">${escHtml(d.name)}</span>
            <span style="font-size:10px;color:#9ca3af">${d.code}</span>
          </div>
          <div style="display:flex;gap:12px;align-items:center;font-size:12px;margin-bottom:4px">
            <span style="padding:2px 8px;border-radius:4px;background:#e5e7eb;color:#6b7280">🤖 算法: ${escHtml(d.algoSignal)}</span>
            <span style="font-size:16px;color:#9ca3af">→</span>
            <span style="padding:2px 8px;border-radius:4px;background:#fef3c7;color:#d97706;font-weight:600">🧠 AI: ${escHtml(d.aiVerdict)}</span>
          </div>
          <div style="font-size:12px;color:#6b7280">${escHtml(d.reason)}</div>
        </div>`).join('');
      disputeHtml = `
      <div style="background:linear-gradient(135deg,#fffbeb,#fef3c7);border-radius:14px;padding:16px 18px;margin-bottom:12px;border:1px solid #fde68a;box-shadow:0 2px 8px rgba(245,158,11,0.1)">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
          <span style="font-size:18px">⚠️</span>
          <span style="font-size:15px;font-weight:700;color:#d97706">今日需关注 · 量化 vs AI 意见分歧</span>
          <span style="font-size:11px;color:#d97706;font-weight:500;padding:2px 8px;background:#fef3c7;border-radius:10px">${disputes.length} 只</span>
        </div>
        <div style="font-size:12px;color:#92400e;margin-bottom:10px;line-height:1.6">以下基金，量化算法和 AI 独立判断意见不一致。建议你重点看，自己拍板。</div>
        ${cards}
      </div>`;
    }

    const mailOptions = {
      from: `"养基日记" <${_emailConfig.user}>`,
      to: _emailConfig.to,
      subject: `🔴 养基日记 · 今日盘中操作指令 [${today}]`,
      html: `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:16px;background:${EMAIL_CSS.bg};font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif">
<div style="max-width:600px;margin:0 auto">

  <!-- Hero Header -->
  <div style="background:linear-gradient(135deg,#1677ff,#4096ff);border-radius:14px;padding:24px 20px;color:#fff;margin-bottom:12px;box-shadow:0 4px 16px rgba(22,119,255,0.2)">
    <div style="font-size:12px;opacity:0.85;margin-bottom:6px">养基日记 · 投资看板</div>
    <div style="font-size:26px;font-weight:700;letter-spacing:0.5px">🔴 今日盘中操作指令</div>
    <div style="font-size:13px;margin-top:10px;color:#fff">${today} ${weekday} ${timeStr} · <span style="font-weight:700;color:#ffe066">⏰ 请在 15:00 前完成操作</span></div>
  </div>

  ${disputeHtml}

  <!-- 主体卡片 -->
  <div style="background:${EMAIL_CSS.cardBg};border-radius:14px;padding:16px 18px;box-shadow:0 2px 8px rgba(0,0,0,0.05)">
    ${htmlBody}
  </div>

  <!-- Footer -->
  <div style="text-align:center;padding:16px 8px 4px">
    <p style="color:${EMAIL_CSS.text3};font-size:11px;margin:0 0 4px">
      🤖 此邮件由养基助手自动生成 · 数据仅供参考，不构成投资建议
    </p>
    <a href="${_dashboardUrl || '#'}" style="color:${EMAIL_CSS.primary};font-size:12px;text-decoration:none">📊 打开 Web 看板 — AI 投资助理在线对话</a>
  </div>

</div>
</body>
</html>`,
    };

    const info = await transporter.sendMail(mailOptions);
    if (_log) _log.info('邮件已发送', { messageId: info.messageId });
    console.log(`📧 邮件已发送！MessageId: ${info.messageId}`);
  } catch (e) {
    if (_log) _log.error('邮件发送失败', { error: e.message });
    console.log(`⚠️ 邮件发送失败: ${e.message}`);
    console.log('   （脚本继续运行，不影响数据分析）');
  }
}

module.exports = { initEmailService, sendEmailNotification };
