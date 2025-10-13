#!/usr/bin/env node
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../lib/db');

async function importAll(){
  const file = path.join(__dirname, '..', 'data', 'reviews.json');
  if (!fs.existsSync(file)){
    console.error('No reviews.json found at', file);
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(file,'utf8') || '{}');
  const slugs = Object.keys(raw || {});
  for(const slug of slugs){
    const arr = raw[slug] || [];
    for(const r of arr.reverse()){ // insert oldest first to preserve ordering
      try{
        const review = Object.assign({}, r);
        // ensure fields
        review.id = review.id || ('r_'+Date.now());
        review.course_id = review.course_id || slug;
        review.created_at = review.created_at || (new Date()).toISOString();
        review.upvotes = review.upvotes || 0;
        review.downvotes = review.downvotes || 0;
        await db.createReview(review);
        if (Array.isArray(r.replies)){
          for(const rp of r.replies.reverse()){
            const reply = Object.assign({}, rp);
            reply.id = reply.id || ('rp_'+Date.now());
            reply.review_id = review.id;
            reply.created_at = reply.created_at || (new Date()).toISOString();
            await db.createReply(reply);
          }
        }
      }catch(e){ console.error('failed to import', r && r.id, e); }
    }
  }
  console.log('Import complete');
}

(async ()=>{
  try{
    await db.initSchema();
    await importAll();
    process.exit(0);
  }catch(e){ console.error('error', e); process.exit(1); }
})();
