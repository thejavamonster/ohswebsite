#!/usr/bin/env node
require('dotenv').config();
const db = require('../lib/db');
(async ()=>{
  try{
    await db.initSchema();
    console.log('Done');
    process.exit(0);
  }catch(e){
    console.error('init_db error', e);
    process.exit(1);
  }
})();
