import { defineConfig, env } from 'prisma/config';
import { config } from 'dotenv';

// Load .env file
config();

// Use DATABASE_URL from environment or provide default
const databaseUrl = process.env.DATABASE_URL || 'file:./prisma/dev.db';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  engine: 'classic',
  datasource: {
    url: databaseUrl,
  },
});
