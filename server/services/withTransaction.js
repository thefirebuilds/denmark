// The owner alone begins, commits, rolls back and releases a transaction.
// Helpers receive its client and append effects to run after commit AND release.
async function withTransaction(pool, work) {
  const client = await pool.connect();
  const afterCommit = [];
  let began = false;
  let releaseError;
  let result;
  try {
    await client.query('BEGIN');
    began = true;
    result = await work(client, afterCommit);
    await client.query('COMMIT');
  } catch (error) {
    if (!began) {
      releaseError = error;
    } else {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        releaseError = rollbackError;
      }
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
  for (const effect of afterCommit) {
    void Promise.resolve().then(effect).catch(error => {
      console.warn('[db] post-commit effect failed:', error.message || error);
    });
  }
  return result;
}

module.exports = { withTransaction };
