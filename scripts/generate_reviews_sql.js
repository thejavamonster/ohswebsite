const fs = require('fs');
const path = require('path');

const dataPath = path.join(__dirname, '..', 'data', 'reviews.json');
const outPath = path.join(__dirname, 'reviews_import.sql');

function esc(v){
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  // escape single quotes and backslashes
  return "'" + String(v).replace(/'/g, "''") + "'";
}

function escTS(v){
  if (!v) return 'NULL';
  return esc(v) + '::timestamptz';
}

const raw = fs.readFileSync(dataPath, 'utf8');
const parsed = JSON.parse(raw);

let parts = [];
parts.push('-- Generated SQL to create tables and insert reviews + replies');
parts.push('BEGIN;');
parts.push("CREATE TABLE IF NOT EXISTS reviews (\n  id TEXT PRIMARY KEY,\n  course_id TEXT NOT NULL,\n  rating INTEGER,\n  author TEXT,\n  text TEXT NOT NULL,\n  created_at TIMESTAMP WITH TIME ZONE,\n  status TEXT,\n  poster_email TEXT,\n  poster_sid TEXT,\n  upvotes INTEGER DEFAULT 0,\n  downvotes INTEGER DEFAULT 0\n);\n");
parts.push("CREATE TABLE IF NOT EXISTS replies (\n  id TEXT PRIMARY KEY,\n  review_id TEXT REFERENCES reviews(id) ON DELETE CASCADE,\n  author TEXT,\n  text TEXT NOT NULL,\n  created_at TIMESTAMP WITH TIME ZONE,\n  poster_email TEXT,\n  poster_sid TEXT\n);\n");

// Insert reviews
for (const [courseId, reviews] of Object.entries(parsed)){
  for (const r of reviews){
    const id = esc(r.id);
    const course_id = esc(r.course_id || courseId);
    const rating = (r.rating === null || r.rating === undefined) ? 'NULL' : esc(r.rating);
    const author = (r.author === null || r.author === undefined) ? 'NULL' : esc(r.author);
    const text = esc(r.text || '');
    const created_at = escTS(r.created_at);
    const status = (r.status === null || r.status === undefined) ? 'NULL' : esc(r.status);
    const poster_email = (r.poster_email === null || r.poster_email === undefined) ? 'NULL' : esc(r.poster_email);
    const poster_sid = (r.poster_sid === null || r.poster_sid === undefined) ? 'NULL' : esc(r.poster_sid);
    const upvotes = (r.upvotes === null || r.upvotes === undefined) ? '0' : esc(r.upvotes);
    const downvotes = (r.downvotes === null || r.downvotes === undefined) ? '0' : esc(r.downvotes);

    const sql = `INSERT INTO reviews(id, course_id, rating, author, text, created_at, status, poster_email, poster_sid, upvotes, downvotes) VALUES(${id}, ${course_id}, ${rating}, ${author}, ${text}, ${created_at}, ${status}, ${poster_email}, ${poster_sid}, ${upvotes}, ${downvotes}) ON CONFLICT (id) DO NOTHING;`;
    parts.push(sql);

    if (Array.isArray(r.replies)){
      for (const rp of r.replies){
        const rid = esc(rp.id);
        const review_id = esc(rp.review_id || r.id);
        const rauthor = (rp.author === null || rp.author === undefined) ? 'NULL' : esc(rp.author);
        const rtext = esc(rp.text || '');
        const rcreated = escTS(rp.created_at);
        const rposter_email = (rp.poster_email === null || rp.poster_email === undefined) ? 'NULL' : esc(rp.poster_email);
        const rposter_sid = (rp.poster_sid === null || rp.poster_sid === undefined) ? 'NULL' : esc(rp.poster_sid);
        const rsql = `INSERT INTO replies(id, review_id, author, text, created_at, poster_email, poster_sid) VALUES(${rid}, ${review_id}, ${rauthor}, ${rtext}, ${rcreated}, ${rposter_email}, ${rposter_sid}) ON CONFLICT (id) DO NOTHING;`;
        parts.push(rsql);
      }
    }
  }
}

parts.push('COMMIT;');

fs.writeFileSync(outPath, parts.join('\n'), 'utf8');
console.log('Wrote', outPath);
