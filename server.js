const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8000;

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname)));

const COURSES_FILE = path.join(__dirname, 'courses.sample.json');
const REVIEWS_FILE = path.join(__dirname, 'data', 'reviews.json');
const SCRAPED_JSON = path.join(__dirname, 'live_courses.json');

function readJson(file){
  try{ return JSON.parse(fs.readFileSync(file,'utf8')); }catch(e){ return null; }
}

function writeJson(file, obj){
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj,null,2),'utf8');
}

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
app.get('/api/courses/:slug/reviews', (req,res)=>{
  const all = readJson(REVIEWS_FILE) || {};
  const list = (all[req.params.slug] || []).map(r => (Object.assign({ replies: [], upvotes: 0, downvotes: 0 }, r)) );
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
app.post('/api/courses/:slug/reviews', (req,res)=>{
  const { rating, text, author } = req.body;
  // rating is optional, but text is required (min 6 chars)
  if (!text || typeof text !== 'string' || text.trim().length < 6) return res.status(400).json({error:'invalid input'});
  if (rating !== undefined && rating !== null){
    const rnum = Number(rating);
    if (!Number.isFinite(rnum) || rnum < 1 || rnum > 5) return res.status(400).json({error:'invalid rating'});
  }
  const slug = req.params.slug;
  const all = readJson(REVIEWS_FILE) || {};
  all[slug] = all[slug] || [];
  const review = { id: 'r_'+Date.now(), course_id: slug, rating: rating === undefined || rating === null ? null : Number(rating), author: author ? String(author).trim() : null, text: text.trim(), created_at: new Date().toISOString(), status:'published', replies: [] };
  all[slug].unshift(review);
  writeJson(REVIEWS_FILE, all);
  res.status(201).json({ success:true, review });
});

// POST /api/courses/:slug/reviews/:reviewId/vote
app.post('/api/courses/:slug/reviews/:reviewId/vote', (req,res)=>{
  // Accepts { vote: 'up'|'down', prev?: 'up'|'down'|null }
  const { vote, prev } = req.body || {};
  if (!vote || (vote !== 'up' && vote !== 'down')) return res.status(400).json({ error: 'invalid vote' });
  if (prev !== undefined && prev !== null && prev !== 'up' && prev !== 'down') return res.status(400).json({ error: 'invalid prev' });
  const slug = req.params.slug;
  const reviewId = req.params.reviewId;
  const all = readJson(REVIEWS_FILE) || {};
  const list = all[slug] || [];
  const review = list.find(r=> r.id === reviewId);
  if (!review) return res.status(404).json({ error: 'review not found' });
  review.upvotes = typeof review.upvotes === 'number' ? review.upvotes : 0;
  review.downvotes = typeof review.downvotes === 'number' ? review.downvotes : 0;
  // Determine update: if prev === vote => undo; if prev is null/undefined => add; if prev !== vote => switch
  if (prev === vote){
    // undo previous vote
    if (vote === 'up') review.upvotes = Math.max(0, review.upvotes - 1);
    else review.downvotes = Math.max(0, review.downvotes - 1);
  } else if (!prev){
    // new vote
    if (vote === 'up') review.upvotes += 1;
    else review.downvotes += 1;
  } else if (prev !== vote){
    // change vote: remove prev, add new
    if (prev === 'up') review.upvotes = Math.max(0, review.upvotes - 1);
    else review.downvotes = Math.max(0, review.downvotes - 1);
    if (vote === 'up') review.upvotes += 1;
    else review.downvotes += 1;
  }
  writeJson(REVIEWS_FILE, all);
  res.json({ success:true, upvotes: review.upvotes, downvotes: review.downvotes });
});

// POST /api/courses/:slug/reviews/:reviewId/replies
app.post('/api/courses/:slug/reviews/:reviewId/replies', (req, res) => {
  const { text, author } = req.body;
  if (!text || typeof text !== 'string' || text.trim().length < 1) return res.status(400).json({ error: 'invalid input' });
  const slug = req.params.slug;
  const reviewId = req.params.reviewId;
  const all = readJson(REVIEWS_FILE) || {};
  const list = all[slug] || [];
  const review = list.find(r => r.id === reviewId);
  if (!review) return res.status(404).json({ error: 'review not found' });
  review.replies = review.replies || [];
  const reply = { id: 'rp_'+Date.now(), review_id: reviewId, author: author ? String(author).trim() : null, text: text.trim(), created_at: new Date().toISOString() };
  review.replies.unshift(reply);
  writeJson(REVIEWS_FILE, all);
  res.status(201).json({ success: true, reply });
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
