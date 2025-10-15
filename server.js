require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
let nodemailer = null;
try{ nodemailer = require('nodemailer'); }catch(e){ /* optional */ }
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8000;

app.use(bodyParser.json());
app.use(cookieParser());

// Apply auth middleware before serving static files so pages require login
app.use(requireAuth);

app.use(express.static(path.join(__dirname)));

const COURSES_FILE = path.join(__dirname, 'courses.sample.json');
const REVIEWS_FILE = path.join(__dirname, 'data', 'reviews.json');
// Reviews store abstraction (Supabase when configured; JSON fallback)
let reviewsStore = null;
try{ reviewsStore = require('./lib/reviewsStore'); }catch(e){ console.error('[BOOT] failed to load reviewsStore', e && e.message ? e.message : e); }
const SCRAPED_JSON = path.join(__dirname, 'live_courses.json');
const AUTH_CODES_FILE = path.join(__dirname, 'data', 'auth-codes.json');
const SESSIONS_FILE = path.join(__dirname, 'data', 'sessions.json');
// Auth code time-to-live (seconds). Default: 15 minutes
const AUTH_CODE_TTL_SECONDS = Number(process.env.AUTH_CODE_TTL_SECONDS) || 15 * 60;
// Minimum seconds between issuing codes to the same email (simple cooldown to deter spamming)
const AUTH_CODE_REQUEST_COOLDOWN_SECONDS = Number(process.env.AUTH_CODE_REQUEST_COOLDOWN_SECONDS) || 30;

function readJson(file){
  try{ return JSON.parse(fs.readFileSync(file,'utf8')); }catch(e){ return null; }
}

function writeJson(file, obj){
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj,null,2),'utf8');
}

function readOrEmpty(file){ try{ return JSON.parse(fs.readFileSync(file,'utf8')) || {}; }catch(e){ return {}; } }

// Basic email transporter factory (uses env SMTP if provided), otherwise null and codes are logged to console
function getTransporter(){
  if (!nodemailer) return null;
  // support SMTP env vars: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE
  const host = process.env.SMTP_HOST;
  if (!host) return null;
  const port = Number(process.env.SMTP_PORT) || 587;
  const secure = (process.env.SMTP_SECURE === 'true');
  const auth = process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : null;
  return nodemailer.createTransport({ host, port, secure, auth });
}

const transporter = getTransporter();
// unified email helper (prefers ReSend when RESEND_API_KEY is set)
let emailer = null;
try{ emailer = require('./lib/email'); }catch(e){ console.error('[BOOT] failed to load ./lib/email', e && e.message ? e.message : e); }

// Sessions: cookie-based. We'll set a signed random id in a cookie and persist session info in data/sessions.json
function createSession(email){
  const sessions = readOrEmpty(SESSIONS_FILE);
  const id = crypto.randomBytes(16).toString('hex');
  sessions[id] = { email, created_at: new Date().toISOString() };
  writeJson(SESSIONS_FILE, sessions);
  return id;
}

function getSession(req){
  const sid = req.cookies && req.cookies['ohs_sid'];
  if (!sid) return null;
  const sessions = readOrEmpty(SESSIONS_FILE);
  return sessions[sid] || null;
}

function requireAuth(req,res,next){
  // allow login page and auth API without session
  if (req.path.startsWith('/api/auth') || req.path === '/login.html' || req.path.startsWith('/assets') || req.path.endsWith('.png') || req.path.endsWith('.css') || req.path.endsWith('.js')) return next();
  const sess = getSession(req);
  if (!sess) return res.redirect('/login.html');
  req.user = { email: sess.email };
  next();
}

function isAdmin(req){
  // admin list can be provided via ADMIN_EMAIL or ADMIN_EMAILS (comma-separated)
  const adminOne = process.env.ADMIN_EMAIL && String(process.env.ADMIN_EMAIL).trim().toLowerCase();
  const adminList = (process.env.ADMIN_EMAILS || '').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
  // prefer req.user but fall back to session lookup in case middleware didn't attach user
  let email = null;
  if (req && req.user && req.user.email) email = String(req.user.email).toLowerCase();
  else {
    try{ const sess = getSession(req); if (sess && sess.email) email = String(sess.email).toLowerCase(); }catch(e){}
  }
  if (!email) return false;
  if (adminOne && email === adminOne) return true;
  if (adminList.length && adminList.includes(email)) return true;
  // convenience: treat this specific account as admin even if ADMIN_EMAIL not set
  if (email === 'jules328@ohs.stanford.edu') return true;
  return false;
}

// Note: requireAuth already applied above before static files

// GET /api/courses
app.get('/api/courses', (req,res)=>{
  // prefer scraped combined JSON when available
  const scraped = readJson(SCRAPED_JSON);
  if (Array.isArray(scraped)) return res.json({ total: scraped.length, results: scraped });
  const courses = readJson(COURSES_FILE) || [];
  res.json({ total: courses.length, results: courses });
});

// GET /api/courses/:slug
app.get('/api/courses/:slug', (req,res)=>{
  const slug = req.params.slug;
  // check scraped combined JSON first
  const scraped = readJson(SCRAPED_JSON);
  if (Array.isArray(scraped)){
    const sslug = String(slug).toLowerCase();
    const found = scraped.find(x=> (x.slug && String(x.slug).toLowerCase()===sslug) || (x.code && String(x.code).toLowerCase()===sslug) );
    if (found) return res.json(found);
  }
  // fallback to sample file
  const courses = readJson(COURSES_FILE) || [];
  const sslug = String(slug).toLowerCase();
  const c = courses.find(x=> (x.slug && String(x.slug).toLowerCase()===sslug) || (x.code && String(x.code).toLowerCase()===sslug) );
  if (!c) return res.status(404).json({error:'not found'});
  res.json(c);
});

// GET /api/courses/:slug/reviews
app.get('/api/courses/:slug/reviews', async (req,res)=>{
  const courseId = req.params.slug;
  let rawList = [];
  try{
    if (reviewsStore) rawList = await reviewsStore.getReviewsByCourse(courseId);
    else {
      const all = readJson(REVIEWS_FILE) || {};
      rawList = (all[courseId] || []).map(r => (Object.assign({ replies: [], upvotes: 0, downvotes: 0 }, r)) );
    }
  }catch(err){
    console.error('[REVIEWS] list error', err && err.message ? err.message : err);
    return res.status(500).json({ error: 'server_error' });
  }
  // redact poster metadata unless admin. Also treat the specific admin email as admin for convenience.
  const sess = getSession(req);
  const allowAdmin = isAdmin(req) || (sess && String(sess.email).toLowerCase() === 'jules328@ohs.stanford.edu');
  const list = rawList.map(r => {
    const copy = Object.assign({}, r);
      // If requester is admin, show the poster's real ID as the public author
      if (allowAdmin && copy.poster_email){
        try{ copy.author = String(copy.poster_email).split('@')[0]; }catch(e){}
      }
      // compute whether the current requester can delete this review/reply (admin or poster)
      const sessionEmail = sess && sess.email ? String(sess.email).toLowerCase() : null;
      copy.can_delete = allowAdmin || (sessionEmail && copy.poster_email && String(copy.poster_email).toLowerCase() === sessionEmail);
      // redact poster metadata for non-admins
      if (!allowAdmin){ delete copy.poster_email; delete copy.poster_sid; }
    // also process replies: if admin, replace reply author with poster localpart when available; redact metadata for non-admins
    if (Array.isArray(copy.replies)){
      copy.replies = copy.replies.map(rep => {
        const rc = Object.assign({}, rep);
        if (allowAdmin && rc.poster_email){ try{ rc.author = String(rc.poster_email).split('@')[0]; }catch(e){} }
        if (!allowAdmin){ delete rc.poster_email; delete rc.poster_sid; }
        return rc;
      });
    }
    return copy;
  });
  // ensure replies array and vote counts exist for each review
  list.forEach(r => { if (!Array.isArray(r.replies)) r.replies = []; if (typeof r.upvotes !== 'number') r.upvotes = 0; if (typeof r.downvotes !== 'number') r.downvotes = 0; });
  // sort by score (upvotes - downvotes) desc, then by created_at desc
  list.sort((a,b)=>{
    const scoreA = (a.upvotes||0) - (a.downvotes||0);
    const scoreB = (b.upvotes||0) - (b.downvotes||0);
    if (scoreB !== scoreA) return scoreB - scoreA;
    const tA = a.created_at ? Date.parse(a.created_at) : 0;
    const tB = b.created_at ? Date.parse(b.created_at) : 0;
    return tB - tA;
  });
  res.json({ total: list.length, results: list });
});

// POST /api/courses/:slug/reviews
app.post('/api/courses/:slug/reviews', async (req,res)=>{
  // enforce server-side author: prefer session name but allow client-supplied author for display; always record poster identity for admin audit
  const sess = getSession(req);
  const sessionName = sess && sess.email ? String(sess.email).split('@')[0] : null;
  const sessionEmail = sess && sess.email ? String(sess.email) : null;
  const sessionId = (()=>{ try{ return req.cookies && req.cookies['ohs_sid'] ? String(req.cookies['ohs_sid']) : null; }catch(e){ return null; } })();
  const { rating, text } = req.body;
  // If the client explicitly provided an `author` field, honor it (allow empty -> anonymous).
  // Otherwise, fall back to the session-derived display name when present.
  let author = null;
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'author')){
    const raw = req.body.author;
    author = (raw === null || raw === undefined) ? null : String(raw).trim();
    if (author === '') author = null; // treat empty string as anonymous/null for display
  } else {
    author = sessionName || null;
  }
  // rating is optional, but text is required (min 6 chars)
  if (!text || typeof text !== 'string' || text.trim().length < 6) return res.status(400).json({error:'invalid input'});
  if (rating !== undefined && rating !== null){
    const rnum = Number(rating);
    if (!Number.isFinite(rnum) || rnum < 1 || rnum > 5) return res.status(400).json({error:'invalid rating'});
  }
  const slug = req.params.slug;
  const review = { id: 'r_'+Date.now(), course_id: slug, rating: rating === undefined || rating === null ? null : Number(rating), author: author ? String(author).trim() : null, text: text.trim(), created_at: new Date().toISOString(), status:'published', replies: [], poster_email: sessionEmail || null, poster_sid: sessionId || null, upvotes: 0, downvotes: 0 };
  try{
    if (reviewsStore) await reviewsStore.createReview(slug, review);
    else {
      const all = readJson(REVIEWS_FILE) || {};
      all[slug] = all[slug] || [];
      all[slug].unshift(review);
      writeJson(REVIEWS_FILE, all);
    }
  }catch(err){
    console.error('[REVIEWS] create error', err && err.message ? err.message : err);
    return res.status(500).json({ error: 'server_error' });
  }
  res.status(201).json({ success:true, review });
});

// --- Authentication endpoints ---
// POST /api/auth/request-code  { email }
app.post('/api/auth/request-code', (req,res)=>{
  const { email } = req.body || {};
  if (!email || typeof email !== 'string') return res.status(400).json({ error: 'invalid email' });
  const trimmed = String(email).trim().toLowerCase();
  if (!trimmed.endsWith('@ohs.stanford.edu')) return res.status(400).json({ error: 'email must be @ohs.stanford.edu' });
  const codes = readOrEmpty(AUTH_CODES_FILE);
  // simple cooldown: if a code was created recently, don't re-issue immediately
  try{
    const prev = codes[trimmed];
    if (prev && prev.created_at){
      const then = Date.parse(prev.created_at);
      if (!Number.isNaN(then)){
        const age = (Date.now() - then) / 1000;
        if (age < AUTH_CODE_REQUEST_COOLDOWN_SECONDS) return res.status(429).json({ error: 'too_many_requests' });
      }
    }
  }catch(e){}
  const code = (''+Math.floor(100000 + Math.random()*900000)).slice(0,6);
  codes[trimmed] = { code, created_at: new Date().toISOString() };
  writeJson(AUTH_CODES_FILE, codes);
  // send email if transporter available, else log
  const subject = 'Your OHS verification code';
  const text = `Your verification code is: ${code}`;
  // Use unified email helper (prefers ReSend when RESEND_API_KEY set, falls back to SMTP)
  (async () => {
    try{
  // prefer an explicit Resend-from address, then SMTP_FROM; avoid falling back to the school's domain
  const defaultFrom = process.env.RESEND_FROM || process.env.SMTP_FROM || 'noreply@websudoku.me';
  const info = await emailer.sendMail({ from: defaultFrom, to: trimmed, subject, text });
      console.log('[AUTH] email send result', info ? (info.id || info.response || info.messageId || info) : 'no-op');
      const resp = { success:true };
      if (process.env.DEV_AUTH_RETURN_CODE === 'true') resp.code = code;
      res.json(resp);
    }catch(err){
      console.error('[AUTH] email send failed', err && err.message ? err.message : err);
      // still return success to avoid leaking existence
      const resp = { success:true, warned: true };
      if (process.env.DEV_AUTH_RETURN_CODE === 'true') resp.code = code;
      res.json(resp);
    }
  })();
});

// POST /api/auth/verify-code { email, code }
app.post('/api/auth/verify-code', (req,res)=>{
  const { email, code } = req.body || {};
  if (!email || !code) return res.status(400).json({ error: 'missing' });
  const trimmed = String(email).trim().toLowerCase();
  const codes = readOrEmpty(AUTH_CODES_FILE);
  const rec = codes[trimmed];
  if (!rec || String(rec.code) !== String(code)) return res.status(400).json({ error: 'invalid code' });
  // enforce TTL
  try{
    if (rec.created_at){
      const then = Date.parse(rec.created_at);
      if (!Number.isNaN(then)){
        const age = (Date.now() - then) / 1000;
        if (age > AUTH_CODE_TTL_SECONDS) return res.status(400).json({ error: 'code_expired' });
      }
    }
  }catch(e){}
  // create session
  const sid = createSession(trimmed);
  // remove code
  delete codes[trimmed]; writeJson(AUTH_CODES_FILE, codes);
  // set cookie (expire 30 days)
  // set a reasonably safe cookie configuration: httpOnly, SameSite lax, and secure in production
  const cookieOpts = { httpOnly: true, maxAge: 30*24*60*60*1000, sameSite: 'lax' };
  if (process.env.NODE_ENV === 'production') cookieOpts.secure = true;
  res.cookie('ohs_sid', sid, cookieOpts);
  res.json({ success:true });
});

// GET /api/auth/whoami
app.get('/api/auth/whoami', (req,res)=>{
  const sess = getSession(req);
  if (!sess) return res.json({ authenticated:false });
  const email = sess.email;
  const name = String(email).split('@')[0];
  res.json({ authenticated:true, email, name });
});

// GET /api/auth/is-admin -> { isAdmin: boolean }
app.get('/api/auth/is-admin', (req, res) => {
  try{
    const yes = isAdmin(req);
    res.json({ isAdmin: !!yes });
  }catch(e){ res.json({ isAdmin: false }); }
});

// POST /api/auth/logout
app.post('/api/auth/logout', (req,res)=>{
  const sid = req.cookies && req.cookies['ohs_sid'];
  if (sid){
    const sessions = readOrEmpty(SESSIONS_FILE);
    if (sessions[sid]){ delete sessions[sid]; writeJson(SESSIONS_FILE, sessions); }
    res.clearCookie('ohs_sid');
  }
  res.json({ success:true });
});

// POST /api/courses/:slug/reviews/:reviewId/vote
app.post('/api/courses/:slug/reviews/:reviewId/vote', async (req,res)=>{
  // Accepts { vote: 'up'|'down', prev?: 'up'|'down'|null }
  const { vote, prev } = req.body || {};
  if (!vote || (vote !== 'up' && vote !== 'down')) return res.status(400).json({ error: 'invalid vote' });
  if (prev !== undefined && prev !== null && prev !== 'up' && prev !== 'down') return res.status(400).json({ error: 'invalid prev' });
  const slug = req.params.slug;
  const reviewId = req.params.reviewId;
  try{
    let next;
    if (reviewsStore){
      next = await reviewsStore.updateVoteCounts(slug, reviewId, ({ upvotes, downvotes }) => {
        let u = upvotes || 0, d = downvotes || 0;
        if (prev === vote){
          if (vote === 'up') u = Math.max(0, u - 1); else d = Math.max(0, d - 1);
        } else if (!prev){
          if (vote === 'up') u += 1; else d += 1;
        } else if (prev !== vote){
          if (prev === 'up') u = Math.max(0, u - 1); else d = Math.max(0, d - 1);
          if (vote === 'up') u += 1; else d += 1;
        }
        return { upvotes: u, downvotes: d };
      });
    } else {
      const all = readJson(REVIEWS_FILE) || {};
      const list = all[slug] || [];
      const review = list.find(r=> r.id === reviewId);
      if (!review) return res.status(404).json({ error: 'review not found' });
      review.upvotes = typeof review.upvotes === 'number' ? review.upvotes : 0;
      review.downvotes = typeof review.downvotes === 'number' ? review.downvotes : 0;
      if (prev === vote){
        if (vote === 'up') review.upvotes = Math.max(0, review.upvotes - 1);
        else review.downvotes = Math.max(0, review.downvotes - 1);
      } else if (!prev){
        if (vote === 'up') review.upvotes += 1;
        else review.downvotes += 1;
      } else if (prev !== vote){
        if (prev === 'up') review.upvotes = Math.max(0, review.upvotes - 1);
        else review.downvotes = Math.max(0, review.downvotes - 1);
        if (vote === 'up') review.upvotes += 1;
        else review.downvotes += 1;
      }
      writeJson(REVIEWS_FILE, all);
      next = { upvotes: review.upvotes, downvotes: review.downvotes };
    }
    res.json({ success:true, upvotes: next.upvotes, downvotes: next.downvotes });
  }catch(err){
    console.error('[REVIEWS] vote error', err && err.message ? err.message : err);
    if (String(err).includes('review not found')) return res.status(404).json({ error: 'review not found' });
    res.status(500).json({ error: 'server_error' });
  }
});

// POST /api/courses/:slug/reviews/:reviewId/replies
app.post('/api/courses/:slug/reviews/:reviewId/replies', async (req, res) => {
  const { text } = req.body;
  // enforce author from session when available
  const sess = getSession(req);
  // Author: if client provided author explicitly, honor it (allow anonymous); otherwise use session-derived name when available
  let author = null;
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'author')){
    const raw = req.body.author;
    author = (raw === null || raw === undefined) ? null : String(raw).trim();
    if (author === '') author = null;
  } else {
    author = sess && sess.email ? String(sess.email).split('@')[0] : null;
  }
  const sessionEmail = sess && sess.email ? String(sess.email) : null;
  const sessionId = (()=>{ try{ return req.cookies && req.cookies['ohs_sid'] ? String(req.cookies['ohs_sid']) : null; }catch(e){ return null; } })();
  if (!text || typeof text !== 'string' || text.trim().length < 1) return res.status(400).json({ error: 'invalid input' });
  const slug = req.params.slug;
  const reviewId = req.params.reviewId;
  const reply = { id: 'rp_'+Date.now(), review_id: reviewId, author: author ? String(author).trim() : null, text: text.trim(), created_at: new Date().toISOString(), poster_email: sessionEmail || null, poster_sid: sessionId || null };
  try{
    if (reviewsStore){
      // Ensure review exists
      const review = await reviewsStore.getReview(slug, reviewId);
      if (!review) return res.status(404).json({ error: 'review not found' });
      await reviewsStore.addReply(slug, reviewId, reply);
    } else {
      const all = readJson(REVIEWS_FILE) || {};
      const list = all[slug] || [];
      const review = list.find(r => r.id === reviewId);
      if (!review) return res.status(404).json({ error: 'review not found' });
      review.replies = review.replies || [];
      review.replies.unshift(reply);
      writeJson(REVIEWS_FILE, all);
    }
    res.status(201).json({ success: true, reply });
  }catch(err){
    console.error('[REVIEWS] add reply error', err && err.message ? err.message : err);
    if (String(err).includes('review not found')) return res.status(404).json({ error: 'review not found' });
    res.status(500).json({ error: 'server_error' });
  }
});

// DELETE /api/courses/:slug/reviews/:reviewId -- allowed for admin or the poster
app.delete('/api/courses/:slug/reviews/:reviewId', async (req, res) => {
  const sess = getSession(req);
  const sessionEmail = sess && sess.email ? String(sess.email).toLowerCase() : null;
  const allowAdmin = isAdmin(req) || (sess && String(sess.email).toLowerCase() === 'jules328@ohs.stanford.edu');
  const slug = req.params.slug;
  const reviewId = req.params.reviewId;
  try{
    let review = null;
    if (reviewsStore){
      review = await reviewsStore.getReview(slug, reviewId);
    } else {
      const all = readJson(REVIEWS_FILE) || {};
      const list = all[slug] || [];
      review = list.find(r=> r.id === reviewId) || null;
    }
    try{
      const sid = req.cookies && req.cookies['ohs_sid'];
      console.log('[DELETE] request', { slug, reviewId, sid, sessionEmail, allowAdmin });
    }catch(e){ /* ignore logging errors */ }
    if (!review) return res.status(404).json({ error: 'review not found' });
    const posterEmail = review.poster_email ? String(review.poster_email).toLowerCase() : null;
    if (!allowAdmin && !(sessionEmail && posterEmail && sessionEmail === posterEmail)) return res.status(403).json({ error: 'forbidden' });
    if (reviewsStore){
      await reviewsStore.deleteReview(slug, reviewId);
    } else {
      const all = readJson(REVIEWS_FILE) || {};
      const list = all[slug] || [];
      const idx = list.findIndex(r=> r.id === reviewId);
      if (idx !== -1){ list.splice(idx, 1); all[slug] = list; writeJson(REVIEWS_FILE, all); }
    }
    res.json({ success:true });
  }catch(err){
    console.error('[REVIEWS] delete error', err && err.message ? err.message : err);
    res.status(500).json({ error: 'server_error' });
  }
});

// Admin endpoint: view all reviews with poster metadata (restricted)
app.get('/api/admin/reviews', (req, res) => {
  // debug: log incoming session id and resolved email to help diagnose 403s
  try{
    const sid = req.cookies && req.cookies['ohs_sid'];
    const sess = sid ? readOrEmpty(SESSIONS_FILE)[sid] : null;
    console.log('[ADMIN] /api/admin/reviews requested, sid=', sid, 'resolved=', sess && sess.email ? sess.email : null);
  }catch(e){ console.error('[ADMIN] debug log error', e); }
  if (!isAdmin(req)){
    console.log('[ADMIN] forbidden: requester is not admin');
    return res.status(403).json({ error: 'forbidden' });
  }
  const raw = readJson(REVIEWS_FILE) || {};
  // produce a processed copy where author is set to poster_email localpart for admin visibility
  const processed = {};
  Object.keys(raw).forEach(slug => {
    processed[slug] = (raw[slug] || []).map(r => {
      const copy = Object.assign({}, r);
      if (copy.poster_email){ try{ copy.author = String(copy.poster_email).split('@')[0]; }catch(e){} }
      // process replies
      if (Array.isArray(copy.replies)){
        copy.replies = copy.replies.map(rep => { const rc = Object.assign({}, rep); if (rc.poster_email){ try{ rc.author = String(rc.poster_email).split('@')[0]; }catch(e){} } return rc; });
      }
      return copy;
    });
  });
  res.json({ total: Object.keys(processed).reduce((acc,k)=>acc + (Array.isArray(processed[k])? processed[k].length:0), 0), results: processed });
});

// Serve course detail page for clean URLs: /courses/:slug
app.get('/courses/:slug', (req,res)=>{
  res.sendFile(path.join(__dirname, 'course.html'));
});

// Serve scraped courses if present
app.get('/api/scraped-courses', (req, res) => {
  try{
    if (!fs.existsSync(SCRAPED_JSON)) return res.status(404).json({ error: 'no scraped file' });
    const data = JSON.parse(fs.readFileSync(SCRAPED_JSON, 'utf8'));
    return res.json({ total: Array.isArray(data) ? data.length : 0, results: data });
  }catch(e){
    return res.status(500).json({ error: 'failed to read scraped file' });
  }
});

// fallback static / 404
app.use((req,res)=>{
  res.status(404).send('Not found');
});

app.listen(PORT, ()=>console.log(`Server listening on http://localhost:${PORT}`));
