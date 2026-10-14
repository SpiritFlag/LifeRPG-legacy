import { connectDatabase } from "../src/database.js";
import { createWebApi } from "../src/web.js";

/** @type {ReturnType<typeof connectDatabase> | undefined} */
let db;
// Lazy connection: rejected requests never connect to Neon.
const handle = createWebApi(
  () => (db ||= connectDatabase(process.env.DATABASE_URL || "")),
);
export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
