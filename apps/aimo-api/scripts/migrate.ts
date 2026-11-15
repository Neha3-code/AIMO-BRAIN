import "dotenv/config";
import { runMigrations } from "../src/migrations.js";

// Applies apps/aimo-api/migrations/*.sql in order, recording each in schema_migrations.
// 001_baseline.sql is the original demo schema and is a no-op on an existing database.
runMigrations(console.log)
  .then((ran) => console.log(ran.length ? `Migration complete (${ran.length} applied).` : "Already up to date."))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
