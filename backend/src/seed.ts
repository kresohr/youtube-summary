import { Pool } from "pg";
import bcrypt from "bcrypt";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not defined");
}

const pool = new Pool({ connectionString });

async function main() {
  const hashedPassword = await bcrypt.hash("admin123", 10);

  const result = await pool.query(
    `INSERT INTO users (id, username, password, created_at)
     VALUES (gen_random_uuid(), $1, $2, NOW())
     ON CONFLICT (username) DO NOTHING
     RETURNING username`,
    ["admin", hashedPassword]
  );

  if (result.rows.length > 0) {
    console.log("Seeded admin user:", result.rows[0].username);
  } else {
    console.log("Admin user already exists, skipping.");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end();
  });
