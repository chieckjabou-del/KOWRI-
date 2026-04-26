import { defineConfig } from "drizzle-kit";
import path from "path";

const dbUrl = process.env.DATABASE_URL ?? "postgres://localhost:5432/kowri_build_placeholder";

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  dialect: "postgresql",
  dbCredentials: {
    url: dbUrl,
  },
});
