const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const DATABASE_URL = process.env.DATABASE_URL || process.env.PGURI || null;
if (!DATABASE_URL){
  console.warn('[DB] No DATABASE_URL provided. Review endpoints will error until configured.');
}

const pool = new Pool({ connectionString: DATABASE_URL });

async function query(text, params){
  if (!DATABASE_URL) throw new Error('No DATABASE_URL');
  const client = await pool.connect();
  try{
    const res = await client.query(text, params);
    return res;
  }finally{
    client.release();
  }
}

async function initSchema(){
  // create reviews and replies tables
  const createReviews = `
  CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY,
    course_id TEXT NOT NULL,
    rating INTEGER,
    author TEXT,
    text TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE,
    status TEXT,
    poster_email TEXT,
    poster_sid TEXT,
    upvotes INTEGER DEFAULT 0,
    downvotes INTEGER DEFAULT 0
  );`;
  const createReplies = `
  CREATE TABLE IF NOT EXISTS replies (
    id TEXT PRIMARY KEY,
    review_id TEXT REFERENCES reviews(id) ON DELETE CASCADE,
    author TEXT,
    text TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE,
    poster_email TEXT,
    poster_sid TEXT
  );`;
  await query(createReviews);
  await query(createReplies);
  console.log('[DB] Schema initialized');
}

// Convenience API for reviews
async function listReviewsForCourse(courseId){
  const res = await query('SELECT * FROM reviews WHERE course_id=$1 ORDER BY (coalesce(upvotes,0)-coalesce(downvotes,0)) DESC, created_at DESC', [courseId]);
  const rows = res.rows || [];
  // fetch replies for these review ids
  const ids = rows.map(r=>r.id);
  if (!ids.length) return [];
  const repRes = await query(`SELECT * FROM replies WHERE review_id = ANY($1::text[]) ORDER BY created_at DESC`, [ids]);
  const repliesBy = {};
  (repRes.rows||[]).forEach(rp => { repliesBy[rp.review_id] = repliesBy[rp.review_id] || []; repliesBy[rp.review_id].push(rp); });
  return rows.map(r => { r.replies = repliesBy[r.id] || []; return r; });
}

async function getReviewById(courseId, reviewId){
  const res = await query('SELECT * FROM reviews WHERE course_id=$1 AND id=$2', [courseId, reviewId]);
  if (!res.rows.length) return null;
  const review = res.rows[0];
  const repRes = await query('SELECT * FROM replies WHERE review_id=$1 ORDER BY created_at DESC', [review.id]);
  review.replies = repRes.rows || [];
  return review;
}

async function createReview(obj){
  const sql = `INSERT INTO reviews(id, course_id, rating, author, text, created_at, status, poster_email, poster_sid, upvotes, downvotes)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`;
  const params = [obj.id, obj.course_id, obj.rating, obj.author, obj.text, obj.created_at, obj.status, obj.poster_email, obj.poster_sid, obj.upvotes||0, obj.downvotes||0];
  await query(sql, params);
  return obj;
}

async function createReply(obj){
  const sql = `INSERT INTO replies(id, review_id, author, text, created_at, poster_email, poster_sid) VALUES($1,$2,$3,$4,$5,$6,$7)`;
  const params = [obj.id, obj.review_id, obj.author, obj.text, obj.created_at, obj.poster_email, obj.poster_sid];
  await query(sql, params);
  return obj;
}

async function deleteReview(courseId, reviewId){
  await query('DELETE FROM reviews WHERE course_id=$1 AND id=$2', [courseId, reviewId]);
}

async function updateVotes(courseId, reviewId, upvotes, downvotes){
  await query('UPDATE reviews SET upvotes=$1, downvotes=$2 WHERE course_id=$3 AND id=$4', [upvotes, downvotes, courseId, reviewId]);
}

module.exports = { query, initSchema, listReviewsForCourse, getReviewById, createReview, createReply, deleteReview, updateVotes };

