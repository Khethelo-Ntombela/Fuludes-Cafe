/**
 * functions/api/admin/marketing/upload.js
 * POST /api/admin/marketing/upload?filename=email.jpeg
 * Same image upload as /api/admin/upload (R2 bucket, 300KB max), reached
 * through the marketing path so admins with only the Marketing permission
 * can add pictures to a newsletter.
 */
export { onRequestPost } from "../upload.js";
