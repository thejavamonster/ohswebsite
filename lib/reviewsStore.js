// Reviews data store abstraction with two providers:
// - Supabase (Postgres) when SUPABASE_URL and SUPABASE_SERVICE_KEY are set
// - JSON file fallback (current behavior) otherwise
//
// Tables expected in Supabase:
//   reviews(id text primary key, course_id text, rating int null, author text null,
//           text text, created_at timestamptz, status text, upvotes int default 0,
//           downvotes int default 0, poster_email text null, poster_sid text null)
//   review_replies(id text primary key, review_id text references reviews(id) on delete cascade,
//                  author text null, text text, created_at timestamptz,
//                  poster_email text null, poster_sid text null)
//
// NOTE: We preserve legacy string IDs (e.g., r_..., rp_...) for backwards compatibility.

const fs = require('fs');
const path = require('path');

const REVIEWS_FILE = path.join(__dirname, '..', 'data', 'reviews.json');

function readJson(file){
  try{ return JSON.parse(fs.readFileSync(file,'utf8')); }catch(e){ return null; }
}
function writeJson(file, obj){
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj,null,2),'utf8');
}

// ---------- JSON provider ----------
const jsonProvider = {
  async getReviewsByCourse(courseId){
    const all = readJson(REVIEWS_FILE) || {};
    const list = Array.isArray(all[courseId]) ? all[courseId] : [];
    // Ensure shape similar to DB: include replies array and vote counters
    return list.map(r => ({
      replies: [], upvotes: 0, downvotes: 0, ...r,
      // replies may be absent in older records
      replies: Array.isArray(r.replies) ? r.replies : []
    }));
  },
  async getReview(courseId, reviewId){
    const all = readJson(REVIEWS_FILE) || {};
    const list = Array.isArray(all[courseId]) ? all[courseId] : [];
    const r = list.find(x => x.id === reviewId);
    return r ? ({ replies: [], upvotes: 0, downvotes: 0, ...r, replies: Array.isArray(r.replies) ? r.replies : [] }) : null;
  },
  async createReview(courseId, review){
    const all = readJson(REVIEWS_FILE) || {};
    all[courseId] = Array.isArray(all[courseId]) ? all[courseId] : [];
    all[courseId].unshift(review);
    writeJson(REVIEWS_FILE, all);
    return review;
  },
  async addReply(courseId, reviewId, reply){
    const all = readJson(REVIEWS_FILE) || {};
    const list = Array.isArray(all[courseId]) ? all[courseId] : [];
    const r = list.find(x => x.id === reviewId);
    if (!r) throw new Error('review not found');
    r.replies = Array.isArray(r.replies) ? r.replies : [];
    r.replies.unshift(reply);
    writeJson(REVIEWS_FILE, all);
    return reply;
  },
  async updateVoteCounts(courseId, reviewId, updater){
    const all = readJson(REVIEWS_FILE) || {};
    const list = Array.isArray(all[courseId]) ? all[courseId] : [];
    const r = list.find(x => x.id === reviewId);
    if (!r) throw new Error('review not found');
    r.upvotes = typeof r.upvotes === 'number' ? r.upvotes : 0;
    r.downvotes = typeof r.downvotes === 'number' ? r.downvotes : 0;
    const { upvotes, downvotes } = updater({ upvotes: r.upvotes, downvotes: r.downvotes });
    r.upvotes = upvotes; r.downvotes = downvotes;
    writeJson(REVIEWS_FILE, all);
    return { upvotes: r.upvotes, downvotes: r.downvotes };
  },
  async deleteReview(courseId, reviewId){
    const all = readJson(REVIEWS_FILE) || {};
    const list = Array.isArray(all[courseId]) ? all[courseId] : [];
    const idx = list.findIndex(x => x.id === reviewId);
    if (idx === -1) return false;
    list.splice(idx, 1);
    all[courseId] = list;
    writeJson(REVIEWS_FILE, all);
    return true;
  }
};

// ---------- Supabase provider ----------
function makeSupabaseProvider(){
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  let supabase = null;
  try{
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(url, key, { auth: { persistSession: false } });
  }catch(e){
    console.error('[REVIEWS] failed to load supabase client', e && e.message ? e.message : e);
    return null;
  }
  return {
    async getReviewsByCourse(courseId){
      const { data, error } = await supabase
        .from('reviews')
        .select('id, course_id, rating, author, text, created_at, status, upvotes, downvotes, poster_email, poster_sid, replies:review_replies(id, review_id, author, text, created_at, poster_email, poster_sid)')
        .eq('course_id', courseId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    },
    async getReview(courseId, reviewId){
      const { data, error } = await supabase
        .from('reviews')
        .select('id, course_id, rating, author, text, created_at, status, upvotes, downvotes, poster_email, poster_sid, replies:review_replies(id, review_id, author, text, created_at, poster_email, poster_sid)')
        .eq('course_id', courseId)
        .eq('id', reviewId)
        .single();
      if (error) return null;
      return data;
    },
    async createReview(courseId, review){
      const { error } = await supabase.from('reviews').insert(review);
      if (error) throw error;
      return review;
    },
    async addReply(courseId, reviewId, reply){
      // courseId is unused here; reviewId links the reply
      const { error } = await supabase.from('review_replies').insert(reply);
      if (error) throw error;
      return reply;
    },
    async updateVoteCounts(courseId, reviewId, updater){
      // Fetch current
      const { data, error } = await supabase
        .from('reviews')
        .select('upvotes, downvotes')
        .eq('course_id', courseId)
        .eq('id', reviewId)
        .single();
      if (error) throw error;
      const curr = { upvotes: data?.upvotes || 0, downvotes: data?.downvotes || 0 };
      const next = updater(curr);
      const { error: uerr } = await supabase
        .from('reviews')
        .update({ upvotes: next.upvotes, downvotes: next.downvotes })
        .eq('course_id', courseId)
        .eq('id', reviewId);
      if (uerr) throw uerr;
      return next;
    },
    async deleteReview(courseId, reviewId){
      const { error } = await supabase
        .from('reviews')
        .delete()
        .eq('course_id', courseId)
        .eq('id', reviewId);
      if (error) throw error;
      return true;
    }
  };
}

const supa = makeSupabaseProvider();
const provider = supa || jsonProvider;

module.exports = {
  usingSupabase: !!supa,
  getReviewsByCourse: provider.getReviewsByCourse,
  getReview: provider.getReview,
  createReview: provider.createReview,
  addReply: provider.addReply,
  updateVoteCounts: provider.updateVoteCounts,
  deleteReview: provider.deleteReview
};
