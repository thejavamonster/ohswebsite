require('dotenv').config();

async function main(){
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key){
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
    process.exit(1);
  }
  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await supabase
    .from('reviews')
    .select('course_id');
  if (error){ console.error(error); process.exit(1); }
  const counts = {};
  for (const row of (data || [])){
    counts[row.course_id] = (counts[row.course_id] || 0) + 1;
  }
  const sorted = Object.keys(counts).sort();
  console.log('Review counts by course:');
  for (const cid of sorted){
    console.log(`${cid}: ${counts[cid]}`);
  }
}

main().catch(err=>{ console.error(err); process.exit(1); });
