let database = null;

function configured() {
  return /^postgres(?:ql)?:\/\//i.test(String(process.env.DATABASE_URL || ''));
}

function sql() {
  if (!configured()) throw new Error('DATABASE_URL is not configured');
  if (!database) {
    const {neon} = require('@neondatabase/serverless');
    database = neon(process.env.DATABASE_URL);
  }
  return database;
}

module.exports = {configured,sql};
