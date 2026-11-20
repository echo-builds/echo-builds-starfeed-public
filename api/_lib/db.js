let database = null;

function connectionString() {
  const raw = String(process.env.DATABASE_URL || '').trim();
  const match = raw.match(/postgres(?:ql)?:\/\/[^\s'"]+/i);
  return match ? match[0] : raw;
}

function configured() {
  return /^postgres(?:ql)?:\/\//i.test(connectionString());
}

function sql() {
  if (!configured()) throw new Error('DATABASE_URL is not configured');
  if (!database) {
    const {neon} = require('@neondatabase/serverless');
    database = neon(connectionString());
  }
  return database;
}

module.exports = {configured,sql};
