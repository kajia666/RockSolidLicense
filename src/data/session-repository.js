function one(db, sql, ...params) {
  return db.prepare(sql).get(...params);
}

export function getSessionRecordById(db, sessionId) {
  return one(db, "SELECT * FROM sessions WHERE id = ?", sessionId);
}

export function getSessionRecordByToken(db, sessionToken) {
  return one(db, "SELECT * FROM sessions WHERE session_token = ?", sessionToken);
}
