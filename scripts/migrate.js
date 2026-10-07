// One-shot deployment migration. Uses the same MySQL advisory lock as startup.
require('dotenv').config();
(async () => {
  const db = require('../src/db/client');
  try {
    await db.ready;
    console.log('Database migrations are up to date.');
  } finally { await require('../src/db/pool').closePool(); }
})().catch(error => {
  console.error('Database migration failed:', error.message);
  process.exitCode = 1;
});
