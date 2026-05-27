import postgres, { Sql } from 'postgres';

export function createSql(databaseUrl: string): Sql {
  return postgres(databaseUrl, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 20,
    prepare: false,
  });
}
