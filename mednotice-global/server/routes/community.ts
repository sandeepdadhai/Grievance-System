import { Router } from "express";
import { z } from "zod";
import { all, count, get, nowIso, run } from "../db.js";
import { randomCode } from "../crypto.js";
import { audit } from "../audit.js";
import { asyncHandler, createRateLimiter, HttpError, meta, parseBody } from "../http.js";
import { requireAuth, requirePermission, requireRole, STAFF_ROLES } from "../auth.js";

/**
 * Community forum: anonymous or patient-authored posts and comments about
 * healthcare experiences, with a moderation console for staff and custom roles
 * that hold the community.moderate permission.
 */
export const communityRouter = Router();
export const communityAdminRouter = Router();

export const COMMUNITY_TOPICS = ["General", "Billing", "Denials of care", "Documents", "Feedback", "Accessibility", "Privacy"];

export const COMMUNITY_GUIDELINES = [
  "Describe your own experience — no names of individual doctors, nurses or other patients.",
  "Do not post phone numbers, email addresses, Aadhaar/PAN numbers or medical record numbers.",
  "No medical advice or diagnosis requests; contact 108 for emergencies.",
  "Moderators may edit, hide or remove content that breaks these rules.",
];

type PostRow = {
  id: string;
  author_user_id: string | null;
  author_name: string;
  is_guest: number;
  title: string;
  body: string;
  topic: string;
  status: string;
  pinned: number;
  edit_note: string | null;
  edited_by: string | null;
  edited_at: string | null;
  created_at: string;
  updated_at: string;
};

type CommentRow = {
  id: string;
  post_id: string;
  author_user_id: string | null;
  author_name: string;
  is_guest: number;
  body: string;
  status: string;
  edit_note: string | null;
  edited_by: string | null;
  edited_at: string | null;
  created_at: string;
  updated_at: string;
};

function postDto(row: PostRow & { comment_count?: number }, viewerId: string | null) {
  return {
    id: row.id,
    authorName: row.author_name,
    isGuest: Boolean(row.is_guest),
    isMine: Boolean(viewerId && row.author_user_id === viewerId),
    title: row.title,
    body: row.body,
    topic: row.topic,
    status: row.status,
    pinned: Boolean(row.pinned),
    commentCount: Number(row.comment_count ?? 0),
    editedAt: row.edited_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function commentDto(row: CommentRow, viewerId: string | null) {
  return {
    id: row.id,
    postId: row.post_id,
    authorName: row.author_name,
    isGuest: Boolean(row.is_guest),
    isMine: Boolean(viewerId && row.author_user_id === viewerId),
    body: row.body,
    status: row.status,
    editedAt: row.edited_at,
    createdAt: row.created_at,
  };
}

const clean = (value: string) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();

const authorNameSchema = z.string().trim().min(2, "Add a display name").max(40);

const postSchema = z.object({
  title: z.string().trim().min(8, "Give your post a clear title").max(140),
  body: z.string().trim().min(20, "Add at least 20 characters of detail").max(4000),
  topic: z.enum(COMMUNITY_TOPICS as [string, ...string[]]),
  authorName: authorNameSchema.optional(),
  guidelines: z.boolean().refine((v) => v, "Please accept the community guidelines"),
});

const commentSchema = z.object({
  body: z.string().trim().min(2, "Write a comment").max(1500),
  authorName: authorNameSchema.optional(),
  guidelines: z.boolean().refine((v) => v, "Please accept the community guidelines"),
});

function resolveAuthor(req: { user?: { id: string; name: string } }, supplied?: string): { id: string | null; name: string; guest: boolean } {
  if (req.user) return { id: req.user.id, name: req.user.name, guest: false };
  if (!supplied) throw new HttpError(400, "A display name is required for guest posts");
  return { id: null, name: supplied, guest: true };
}

/* ------------------------------- public API ------------------------------ */

communityRouter.get("/topics", (_req, res) => {
  res.json({ topics: COMMUNITY_TOPICS, guidelines: COMMUNITY_GUIDELINES });
});

communityRouter.get(
  "/posts",
  asyncHandler((req, res) => {
    const topic = typeof req.query.topic === "string" && COMMUNITY_TOPICS.includes(req.query.topic) ? req.query.topic : null;
    const q = typeof req.query.q === "string" && req.query.q.trim() ? `%${req.query.q.trim().slice(0, 80)}%` : null;
    const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 20) || 20));
    const offset = Math.max(0, Number(req.query.offset ?? 0) || 0);
    const where = ["p.status = 'VISIBLE'"];
    const params: unknown[] = [];
    if (topic) {
      where.push("p.topic = ?");
      params.push(topic);
    }
    if (q) {
      where.push("(p.title LIKE ? OR p.body LIKE ?)");
      params.push(q, q);
    }
    const clause = `WHERE ${where.join(" AND ")}`;
    const rows = all<PostRow & { comment_count: number }>(
      `SELECT p.*, (SELECT COUNT(*) FROM community_comments c WHERE c.post_id = p.id AND c.status = 'VISIBLE') AS comment_count
       FROM community_posts p ${clause}
       ORDER BY p.pinned DESC, p.created_at DESC LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset,
    );
    const total = count(`SELECT COUNT(*) AS n FROM community_posts p ${clause}`, ...params);
    res.json({ posts: rows.map((r) => postDto(r, req.user?.id ?? null)), total, limit, offset, topics: COMMUNITY_TOPICS, guidelines: COMMUNITY_GUIDELINES });
  }),
);

communityRouter.get(
  "/posts/:id",
  asyncHandler((req, res) => {
    const row = get<PostRow & { comment_count: number }>(
      `SELECT p.*, (SELECT COUNT(*) FROM community_comments c WHERE c.post_id = p.id AND c.status = 'VISIBLE') AS comment_count
       FROM community_posts p WHERE p.id = ?`,
      req.params.id,
    );
    if (!row || row.status !== "VISIBLE") throw new HttpError(404, "This post is no longer available");
    const comments = all<CommentRow>(
      "SELECT * FROM community_comments WHERE post_id = ? AND status = 'VISIBLE' ORDER BY created_at",
      row.id,
    );
    res.json({ post: postDto(row, req.user?.id ?? null), comments: comments.map((c) => commentDto(c, req.user?.id ?? null)) });
  }),
);

communityRouter.post(
  "/posts",
  createRateLimiter({ bucket: "community-post", windowMs: 10 * 60_000, max: 6 }),
  asyncHandler((req, res) => {
    const body = parseBody(postSchema, req.body);
    const author = resolveAuthor(req, body.authorName);
    const id = `POST-${randomCode(8)}`;
    const now = nowIso();
    run(
      `INSERT INTO community_posts (id, author_user_id, author_name, is_guest, title, body, topic, status, pinned, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'VISIBLE', 0, ?, ?)`,
      id,
      author.id,
      author.name,
      author.guest ? 1 : 0,
      clean(body.title),
      clean(body.body),
      body.topic,
      now,
      now,
    );
    audit({
      actor: author.id ? { id: author.id, role: req.user!.role } : { id: null, role: "PUBLIC" },
      action: "COMMUNITY_POST_CREATED",
      entityType: "community_post",
      entityId: id,
      ...meta(req),
      details: { topic: body.topic, guest: author.guest, titleLength: body.title.length },
    });
    res.status(201).json({ post: postDto(get<PostRow>("SELECT * FROM community_posts WHERE id = ?", id)!, author.id) });
  }),
);

communityRouter.post(
  "/posts/:id/comments",
  createRateLimiter({ bucket: "community-comment", windowMs: 10 * 60_000, max: 12 }),
  asyncHandler((req, res) => {
    const body = parseBody(commentSchema, req.body);
    const post = get<PostRow>("SELECT * FROM community_posts WHERE id = ?", req.params.id);
    if (!post || post.status !== "VISIBLE") throw new HttpError(404, "This post is no longer open for comments");
    const author = resolveAuthor(req, body.authorName);
    const id = `CMT-${randomCode(8)}`;
    const now = nowIso();
    run(
      `INSERT INTO community_comments (id, post_id, author_user_id, author_name, is_guest, body, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'VISIBLE', ?, ?)`,
      id,
      post.id,
      author.id,
      author.name,
      author.guest ? 1 : 0,
      clean(body.body),
      now,
      now,
    );
    run("UPDATE community_posts SET updated_at = ? WHERE id = ?", now, post.id);
    audit({
      actor: author.id ? { id: author.id, role: req.user!.role } : { id: null, role: "PUBLIC" },
      action: "COMMUNITY_COMMENT_CREATED",
      entityType: "community_comment",
      entityId: id,
      ...meta(req),
      details: { postId: post.id, guest: author.guest },
    });
    res.status(201).json({ comment: commentDto(get<CommentRow>("SELECT * FROM community_comments WHERE id = ?", id)!, author.id) });
  }),
);

/* ------------------------------ moderation ------------------------------- */

communityAdminRouter.use(requireAuth, requireRole(...STAFF_ROLES), requirePermission("community.moderate"));

communityAdminRouter.get(
  "/posts",
  asyncHandler((req, res) => {
    const status = typeof req.query.status === "string" && ["VISIBLE", "HIDDEN", "REMOVED"].includes(req.query.status) ? req.query.status : null;
    const q = typeof req.query.q === "string" && req.query.q.trim() ? `%${req.query.q.trim().slice(0, 80)}%` : null;
    const where: string[] = [];
    const params: unknown[] = [];
    if (status) {
      where.push("p.status = ?");
      params.push(status);
    }
    if (q) {
      where.push("(p.title LIKE ? OR p.body LIKE ? OR p.author_name LIKE ?)");
      params.push(q, q, q);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = all<PostRow & { comment_count: number; hidden_comments: number }>(
      `SELECT p.*,
        (SELECT COUNT(*) FROM community_comments c WHERE c.post_id = p.id) AS comment_count,
        (SELECT COUNT(*) FROM community_comments c WHERE c.post_id = p.id AND c.status != 'VISIBLE') AS hidden_comments
       FROM community_posts p ${clause} ORDER BY p.created_at DESC LIMIT 200`,
      ...params,
    );
    res.json({
      posts: rows.map((r) => ({ ...postDto(r, req.user!.id), hiddenComments: Number(r.hidden_comments) })),
      counts: {
        visible: count("SELECT COUNT(*) AS n FROM community_posts WHERE status = 'VISIBLE'"),
        hidden: count("SELECT COUNT(*) AS n FROM community_posts WHERE status = 'HIDDEN'"),
        comments: count("SELECT COUNT(*) AS n FROM community_comments"),
      },
    });
  }),
);

communityAdminRouter.get(
  "/posts/:id/comments",
  asyncHandler((req, res) => {
    const post = get<PostRow>("SELECT * FROM community_posts WHERE id = ?", req.params.id);
    if (!post) throw new HttpError(404, "Post not found");
    const comments = all<CommentRow>("SELECT * FROM community_comments WHERE post_id = ? ORDER BY created_at", post.id);
    res.json({ post: postDto(post, req.user!.id), comments: comments.map((c) => commentDto(c, req.user!.id)) });
  }),
);

const moderationSchema = z.object({
  title: z.string().trim().min(8).max(140).optional(),
  body: z.string().trim().min(20).max(4000).optional(),
  topic: z.enum(COMMUNITY_TOPICS as [string, ...string[]]).optional(),
  status: z.enum(["VISIBLE", "HIDDEN", "REMOVED"]).optional(),
  pinned: z.boolean().optional(),
  note: z.string().trim().max(300).optional(),
});

communityAdminRouter.patch(
  "/posts/:id",
  asyncHandler((req, res) => {
    const body = parseBody(moderationSchema, req.body);
    const post = get<PostRow>("SELECT * FROM community_posts WHERE id = ?", req.params.id);
    if (!post) throw new HttpError(404, "Post not found");
    const contentChanged = body.title !== undefined || body.body !== undefined || body.topic !== undefined;
    const now = nowIso();
    run(
      `UPDATE community_posts SET title = ?, body = ?, topic = ?, status = ?, pinned = ?, edit_note = ?, edited_by = ?, edited_at = ?, updated_at = ?
       WHERE id = ?`,
      body.title !== undefined ? clean(body.title) : post.title,
      body.body !== undefined ? clean(body.body) : post.body,
      body.topic ?? post.topic,
      body.status ?? post.status,
      body.pinned === undefined ? post.pinned : body.pinned ? 1 : 0,
      body.note ?? post.edit_note,
      contentChanged ? req.user!.id : post.edited_by,
      contentChanged ? now : post.edited_at,
      now,
      post.id,
    );
    audit({
      actor: { id: req.user!.id, role: req.user!.role },
      action: "COMMUNITY_POST_MODERATED",
      entityType: "community_post",
      entityId: post.id,
      ...meta(req),
      details: { changes: body, previousStatus: post.status, contentEdited: contentChanged },
    });
    const fresh = get<PostRow>("SELECT * FROM community_posts WHERE id = ?", post.id)!;
    res.json({ post: postDto(fresh, req.user!.id) });
  }),
);

communityAdminRouter.delete(
  "/posts/:id",
  asyncHandler((req, res) => {
    const post = get<PostRow>("SELECT * FROM community_posts WHERE id = ?", req.params.id);
    if (!post) throw new HttpError(404, "Post not found");
    const comments = all<CommentRow>("SELECT * FROM community_comments WHERE post_id = ?", post.id);
    audit({
      actor: { id: req.user!.id, role: req.user!.role },
      action: "COMMUNITY_POST_REMOVED",
      entityType: "community_post",
      entityId: post.id,
      ...meta(req),
      details: { snapshot: { title: post.title, body: post.body, authorName: post.author_name, topic: post.topic, status: post.status }, comments: comments.length },
    });
    run("DELETE FROM community_posts WHERE id = ?", post.id);
    res.json({ ok: true, removedComments: comments.length });
  }),
);

const commentModerationSchema = z.object({
  body: z.string().trim().min(2).max(1500).optional(),
  status: z.enum(["VISIBLE", "HIDDEN", "REMOVED"]).optional(),
  note: z.string().trim().max(300).optional(),
});

communityAdminRouter.patch(
  "/comments/:id",
  asyncHandler((req, res) => {
    const body = parseBody(commentModerationSchema, req.body);
    const comment = get<CommentRow>("SELECT * FROM community_comments WHERE id = ?", req.params.id);
    if (!comment) throw new HttpError(404, "Comment not found");
    const contentChanged = body.body !== undefined;
    const now = nowIso();
    run(
      "UPDATE community_comments SET body = ?, status = ?, edit_note = ?, edited_by = ?, edited_at = ?, updated_at = ? WHERE id = ?",
      body.body !== undefined ? clean(body.body) : comment.body,
      body.status ?? comment.status,
      body.note ?? comment.edit_note,
      contentChanged ? req.user!.id : comment.edited_by,
      contentChanged ? now : comment.edited_at,
      now,
      comment.id,
    );
    audit({
      actor: { id: req.user!.id, role: req.user!.role },
      action: "COMMUNITY_COMMENT_MODERATED",
      entityType: "community_comment",
      entityId: comment.id,
      ...meta(req),
      details: { changes: body, previousStatus: comment.status, postId: comment.post_id, contentEdited: contentChanged },
    });
    res.json({ comment: commentDto(get<CommentRow>("SELECT * FROM community_comments WHERE id = ?", comment.id)!, req.user!.id) });
  }),
);

communityAdminRouter.delete(
  "/comments/:id",
  asyncHandler((req, res) => {
    const comment = get<CommentRow>("SELECT * FROM community_comments WHERE id = ?", req.params.id);
    if (!comment) throw new HttpError(404, "Comment not found");
    audit({
      actor: { id: req.user!.id, role: req.user!.role },
      action: "COMMUNITY_COMMENT_REMOVED",
      entityType: "community_comment",
      entityId: comment.id,
      ...meta(req),
      details: { snapshot: { body: comment.body, authorName: comment.author_name, status: comment.status }, postId: comment.post_id },
    });
    run("DELETE FROM community_comments WHERE id = ?", comment.id);
    res.json({ ok: true });
  }),
);

