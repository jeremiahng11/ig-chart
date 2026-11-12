'use strict';

// Alert delivery to Telegram and e-mail (no dependencies). Configured only through environment variables:
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID                       → Bot API sendMessage
//   SMTP_HOST, SMTP_PORT (465 = TLS, 587/25 = STARTTLS), SMTP_USER, SMTP_PASS, SMTP_FROM, ALERT_EMAIL_TO
// Secrets never appear in logs or API responses.

const https = require('https');
const net = require('net');
const tls = require('tls');
const os = require('os');

const env = (k) => (process.env[k] || '').trim();
const telegramOn = () => !!(env('TELEGRAM_BOT_TOKEN') && env('TELEGRAM_CHAT_ID'));
const emailOn = () => !!(env('SMTP_HOST') && env('ALERT_EMAIL_TO') && (env('SMTP_FROM') || env('SMTP_USER')));
const status = () => ({ telegram: telegramOn(), email: emailOn() });

function telegram(text) {
  const body = JSON.stringify({ chat_id: env('TELEGRAM_CHAT_ID'), text: text.slice(0, 4000), disable_web_page_preview: true });
  return new Promise((resolve) => {
    const req = https.request({
      host: 'api.telegram.org', path: `/bot${env('TELEGRAM_BOT_TOKEN')}/sendMessage`, method: 'POST', timeout: 10000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; });
      res.on('end', () => { let j = {}; try { j = JSON.parse(b); } catch {} resolve(j.ok ? { ok: true } : { ok: false, error: j.description || `HTTP ${res.statusCode}` }); });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.end(body);
  });
}

// Minimal SMTP client: EHLO, optional STARTTLS, AUTH LOGIN, one message.
function smtpSend({ subject, text }) {
  const host = env('SMTP_HOST'), port = Number(env('SMTP_PORT')) || 587, user = env('SMTP_USER'), pass = env('SMTP_PASS');
  const from = env('SMTP_FROM') || user, to = env('ALERT_EMAIL_TO').split(',').map((s) => s.trim()).filter(Boolean);
  const addr = (s) => (s.match(/<([^>]+)>/) || [null, s])[1];
  return new Promise((resolve) => {
    let sock, buf = '', waiter = null, done = false;
    const finish = (r) => { if (done) return; done = true; try { sock.end(); } catch {} resolve(r); };
    const timer = setTimeout(() => finish({ ok: false, error: 'SMTP timeout' }), 20000);
    const onData = (d) => {
      buf += d;
      const m = buf.match(/(?:^|\r\n)(\d{3}) [^\r\n]*\r\n$/);
      if (m && waiter) { const w = waiter, text = buf; waiter = null; buf = ''; w(Number(m[1]), text); }
    };
    const attach = (s) => { sock = s; s.setEncoding('utf8'); s.on('data', onData); s.on('error', (e) => { clearTimeout(timer); finish({ ok: false, error: e.message }); }); };
    const expect = (codes) => new Promise((res, rej) => { waiter = (code, text) => (codes.includes(code) ? res(text) : rej(new Error(`SMTP ${code} ${text.trim().split('\r\n').pop().slice(4, 200)}`))); });
    const cmd = (line, codes) => { const p = expect(codes); sock.write(line + '\r\n'); return p; };
    const hello = os.hostname().replace(/[^\w.-]/g, '') || 'localhost';
    const run = async () => {
      await expect([220]);
      let caps = await cmd(`EHLO ${hello}`, [250]);
      if (port !== 465 && /STARTTLS/i.test(caps)) {
        await cmd('STARTTLS', [220]);
        sock.removeListener('data', onData);
        await new Promise((r, j) => { const t = tls.connect({ socket: sock, servername: host }, r); t.on('error', j); attach(t); });
        caps = await cmd(`EHLO ${hello}`, [250]);
      }
      if (user) {
        await cmd('AUTH LOGIN', [334]);
        await cmd(Buffer.from(user).toString('base64'), [334]);
        await cmd(Buffer.from(pass).toString('base64'), [235]);
      }
      await cmd(`MAIL FROM:<${addr(from)}>`, [250]);
      for (const t of to) await cmd(`RCPT TO:<${addr(t)}>`, [250, 251]);
      await cmd('DATA', [354]);
      const enc = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);
      const msg = [
        `From: ${from}`, `To: ${to.join(', ')}`, `Subject: ${enc(subject)}`, `Date: ${new Date().toUTCString()}`,
        'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '',
        Buffer.from(text).toString('base64').replace(/.{76}/g, '$&\r\n'),
      ].join('\r\n');
      await cmd(msg + '\r\n.', [250]);
      await cmd('QUIT', [221]).catch(() => {});
      clearTimeout(timer); finish({ ok: true });
    };
    const s = port === 465 ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    attach(s);
    run().catch((e) => { clearTimeout(timer); finish({ ok: false, error: e.message }); });
  });
}

// Send to every configured channel the alert allows (alert.telegram / alert.email !== false).
async function deliver({ title, message, alert }) {
  const out = {};
  const text = `${title}\n${message}`;
  if (telegramOn() && (!alert || alert.telegram !== false)) out.telegram = await telegram(text);
  if (emailOn() && (!alert || alert.email !== false)) out.email = await smtpSend({ subject: `[IG Charts] ${title}`, text: `${message}\n\n— IG Charts alert` });
  for (const [k, r] of Object.entries(out)) if (!r.ok) console.warn(`[alerts] ${k} delivery failed:`, r.error);
  return out;
}

module.exports = { status, deliver, telegram, smtpSend };
