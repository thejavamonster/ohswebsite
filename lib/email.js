// Lightweight email helper that prefers ReSend (resend SDK) when RESEND_API_KEY
// is configured. Falls back to SMTP (env vars) if available, otherwise logs.
// Usage: const emailer = require('./lib/email'); await emailer.sendMail({ from, to, subject, text, html })
const RESEND_KEY = process.env.RESEND_API_KEY || process.env.RESEND_KEY || null;
let resendClient = null;
if (RESEND_KEY){
  try{
    const { Resend } = require('resend');
    resendClient = new Resend(RESEND_KEY);
  }catch(e){
    console.error('[EMAIL] failed to load resend client (is package installed?):', e && e.message ? e.message : e);
    resendClient = null;
  }
}

async function smtpSend({ from, to, subject, text, html }){
  try{
    const nodemailer = require('nodemailer');
    const host = process.env.SMTP_HOST;
    if (!host) throw new Error('no SMTP_HOST');
    const port = Number(process.env.SMTP_PORT) || 587;
    const secure = process.env.SMTP_SECURE === 'true';
    const auth = process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : null;
    const transporter = nodemailer.createTransport({ host, port, secure, auth });
    const info = await transporter.sendMail({ from, to, subject, text, html });
    console.log('[EMAIL] smtp sent', info && (info.response || info.messageId) ? (info.response || info.messageId) : info);
    return info;
  }catch(e){
    console.error('[EMAIL] smtp send failed', e && e.message ? e.message : e);
    throw e;
  }
}

module.exports = {
  // options: { from, to, subject, text, html }
  async sendMail(opts){
    const { from, to, subject, text, html } = opts || {};
    if (!to) throw new Error('missing `to`');
    // Try ReSend first
    if (resendClient){
      try{
        // prefer an explicit Resend-from address, then SMTP_FROM, then a safe fallback
        const defaultFrom = process.env.RESEND_FROM || process.env.SMTP_FROM || 'noreply@websudoku.me';
        const payload = { from: from || defaultFrom, to, subject };
        if (html) payload.html = html;
        if (text) payload.text = text;
        const resp = await resendClient.emails.send(payload);
        console.log('[EMAIL] resend sent', resp && resp.id ? resp.id : resp);
        return resp;
      }catch(e){
        // ReSend may reject sends from unverified domains (validation_error). Log the full error for diagnosis
        console.error('[EMAIL] resend send failed, will attempt SMTP fallback if configured', e && e.message ? e.message : e);
        if (e && e.name === 'validation_error'){
          console.error('[EMAIL] resend validation error — likely unverified sending domain. Check RESEND dashboard for domain verification.');
        }
        // fall through to SMTP
      }
    }
    // Try SMTP fallback
    if (process.env.SMTP_HOST){
      return smtpSend({ from, to, subject, text, html });
    }
    // Last resort: log the message (useful in dev)
    console.log('[EMAIL] no provider configured - would send', { from: from || process.env.SMTP_FROM || 'noreply@websudoku.me', to, subject, text, html });
    return null;
  }
};
