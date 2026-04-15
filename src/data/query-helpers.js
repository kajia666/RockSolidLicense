function makeSqlPlaceholders(count) {
  return Array.from({ length: Math.max(0, Number(count) || 0) }, () => "?").join(", ");
}

function makePostgresPlaceholders(startIndex, count) {
  return Array.from({ length: Math.max(0, Number(count) || 0) }, (_, index) => `$${startIndex + index}`).join(", ");
}

export function appendSqliteInCondition(columnSql, values, conditions, params) {
  if (!Array.isArray(values)) {
    return;
  }

  const normalized = Array.from(
    new Set(
      values
        .map((value) => String(value ?? "").trim())
        .filter(Boolean)
    )
  );

  if (!normalized.length) {
    conditions.push("1 = 0");
    return;
  }

  conditions.push(`${columnSql} IN (${makeSqlPlaceholders(normalized.length)})`);
  params.push(...normalized);
}

export function appendPostgresInCondition(columnSql, values, conditions, params) {
  if (!Array.isArray(values)) {
    return;
  }

  const normalized = Array.from(
    new Set(
      values
        .map((value) => String(value ?? "").trim())
        .filter(Boolean)
    )
  );

  if (!normalized.length) {
    conditions.push("1 = 0");
    return;
  }

  conditions.push(`${columnSql} IN (${makePostgresPlaceholders(params.length + 1, normalized.length)})`);
  params.push(...normalized);
}

export function escapeLikeText(value) {
  return String(value ?? "").replace(/[\\%_]/g, "\\$&");
}

export function likeFilter(value) {
  return `%${escapeLikeText(value)}%`;
}
