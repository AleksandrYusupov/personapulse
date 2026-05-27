import { runMigrations } from '../db/migrator';

runMigrations().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
