// POST /api/admin/upload?filename=prawns.webp
import { jsonResponse } from "../../_lib/db.js";
import { requireAdmin } from "../../_lib/auth.js";

const MAX_BYTES = 300 * 1024; // 300KB - matches the client-side compression target

export async function onRequestPost(context) {
  const { request, env } = context;

  const authError = await requireAdmin(request, env);
  if (authError) return authError;

  if (!env.FULUDE_BUCKET) {
    return jsonResponse(
      {
        error:
          "R2 bucket binding (FULUDE_BUCKET) is not configured on the server.",
      },
      500,
    );
  }
  if (!env.R2_PUBLIC_URL) {
    return jsonResponse(
      { error: "R2_PUBLIC_URL is not configured on the server." },
      500,
    );
  }

  const url = new URL(request.url);
  const rawName = (
    url.searchParams.get("filename") || "dish.webp"
  ).toLowerCase();
  const safeExt = rawName.endsWith(".webp")
    ? "webp"
    : rawName
        .split(".")
        .pop()
        .replace(/[^a-z0-9]/g, "") || "webp";

  const bytes = await request.arrayBuffer();
  if (!bytes || bytes.byteLength === 0) {
    return jsonResponse({ error: "No image data received." }, 400);
  }
  if (bytes.byteLength > MAX_BYTES) {
    return jsonResponse(
      {
        error: `Image is too large (${Math.round(bytes.byteLength / 1024)}KB). Please keep it under 300KB.`,
      },
      400,
    );
  }

  // Unique, URL-safe object key: menu/<timestamp>-<random>.webp
  const key = `menu/${Date.now()}-${crypto.randomUUID()}.${safeExt}`;

  try {
    await env.FULUDE_BUCKET.put(key, bytes, {
      httpMetadata: {
        contentType: safeExt === "webp" ? "image/webp" : `image/${safeExt}`,
      },
    });

    const publicUrl = `${env.R2_PUBLIC_URL.replace(/\/$/, "")}/${key}`;
    return jsonResponse({ success: true, url: publicUrl, key });
  } catch (err) {
    return jsonResponse(
      { error: "Failed to upload image to R2.", message: err.message },
      500,
    );
  }
}
