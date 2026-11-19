const fs = require('fs');
const path = require('path');
const {sql,configured} = require('../api/_lib/db');

async function main() {
  if (!configured()) throw new Error('DATABASE_URL is required');
  const source = fs.readFileSync(path.join(__dirname,'../db/schema.sql'),'utf8');
  const statements = source.split(/;\s*(?:\n|$)/).map(value=>value.trim()).filter(Boolean);
  const db = sql();
  for (const statement of statements) await db.query(statement);
  console.log(`Applied ${statements.length} schema statements.`);
}

main().catch(error=>{ console.error(error); process.exitCode = 1; });
