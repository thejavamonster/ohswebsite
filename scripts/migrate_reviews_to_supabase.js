// One-off importer: push data/reviews.json into Supabase tables
// Usage: node scripts/migrate_reviews_to_supabase.js
// Requires env: SUPABASE_URL, SUPABASE_SERVICE_KEY

const fs = require('fs');
const path = require('path');
require('dotenv').config();

async function main(){
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key){
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
    process.exit(1);
  }
  let createClient;
  try{ ({ createClient } = require('@supabase/supabase-js')); }
  catch(e){
    console.error('Please install @supabase/supabase-js first: npm i @supabase/supabase-js');
    process.exit(1);
  }
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const file = path.join(process.cwd(), 'data', 'reviews.json');
  let json;
  try{ json = JSON.parse(fs.readFileSync(file,'utf8')); }
  catch(e){ console.error('Failed to read data/reviews.json', e.message || e); process.exit(1); }

  // Flatten into arrays
  const reviews = [];
  const replies = [];
  for (const [courseId, list] of Object.entries(json)){
    if (!Array.isArray(list)) continue;
    for (const r of list){
      const base = {
        id: String(r.id),
        course_id: String(r.course_id || courseId),
        rating: r.rating === undefined || r.rating === null ? null : Number(r.rating),
        author: r.author === undefined ? null : r.author,
        text: String(r.text || ''),
        created_at: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
        status: r.status || 'published',
        upvotes: typeof r.upvotes === 'number' ? r.upvotes : 0,
        downvotes: typeof r.downvotes === 'number' ? r.downvotes : 0,
        poster_email: r.poster_email || null,
        poster_sid: r.poster_sid || null
      };
      reviews.push(base);
      const reps = Array.isArray(r.replies) ? r.replies : [];
      for (const rep of reps){
        replies.push({
          id: String(rep.id), review_id: String(rep.review_id || r.id),
          author: rep.author === undefined ? null : rep.author,
          text: String(rep.text || ''),
          created_at: rep.created_at ? new Date(rep.created_at).toISOString() : new Date().toISOString(),
          poster_email: rep.poster_email || null,
          poster_sid: rep.poster_sid || null
        });
      }
    }
  }

  // Upsert in chunks for safety
  async function batchInsert(table, rows){
    const size = 500; // Supabase allows large payloads; keep it modest
    for (let i=0;i<rows.length;i+=size){
      const chunk = rows.slice(i, i+size);
      const { error } = await supabase.from(table).upsert(chunk, { onConflict: 'id' });
      if (error){
        console.error(`Failed inserting into ${table} at batch starting ${i}:`, error.message || error);
        process.exit(1);
      }
      console.log(`[OK] upserted ${chunk.length} into ${table} (${i+chunk.length}/${rows.length})`);
    }
  }

  console.log(`Preparing to migrate ${reviews.length} reviews and ${replies.length} replies...`);
  await batchInsert('reviews', reviews);
  if (replies.length) await batchInsert('review_replies', replies);
  console.log('Done.');
}

main().catch(err=>{ console.error(err); process.exit(1); });
