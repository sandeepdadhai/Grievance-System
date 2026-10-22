import { useEffect, useState } from "react";
import { api, formatDate, timeAgo } from "../../api";
import { useAuth } from "../../auth";
import type { CommunityComment, CommunityPost } from "../../types";
import { Alert, Badge, Card, EmptyState, Icon, Modal, Spinner } from "../../components/ui";

type AdminPost = CommunityPost & { hiddenComments?: number };

type PostPayload = {
  posts: AdminPost[];
  counts: { visible: number; hidden: number; comments: number };
};

const STATUS_TONE: Record<string, "ok" | "warn" | "bad" | "muted"> = {
  VISIBLE: "ok",
  HIDDEN: "warn",
  REMOVED: "bad",
};

export default function AdminCommunity() {
  const { user } = useAuth();
  const [data, setData] = useState<PostPayload | null>(null);
  const [topics, setTopics] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState({ input: "", applied: "" });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<{ post: AdminPost; title: string; body: string; topic: string; note: string; pinned: boolean } | null>(null);
  const [details, setDetails] = useState<{ post: AdminPost; comments: CommunityComment[] } | null>(null);
  const [commentEdit, setCommentEdit] = useState<{ id: string; body: string; note: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  async function load() {
    try {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (search.applied) params.set("q", search.applied);
      const res = await api.get<PostPayload>(`/api/admin/community/posts?${params.toString()}`);
      setData(res);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    void load();
  }, [status, search.applied]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    api.get<{ topics: string[] }>("/api/community/topics").then((r) => setTopics(r.topics)).catch(() => setTopics([]));
  }, []);

  async function act(fn: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(message);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setConfirmRemove(null);
    }
  }

  async function openDetails(post: AdminPost) {
    setError(null);
    try {
      const res = await api.get<{ post: AdminPost; comments: CommunityComment[] }>(`/api/admin/community/posts/${post.id}/comments`);
      setDetails({ post: res.post, comments: res.comments });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function reloadDetails(postId: string) {
    try {
      const res = await api.get<{ post: AdminPost; comments: CommunityComment[] }>(`/api/admin/community/posts/${postId}/comments`);
      setDetails({ post: res.post, comments: res.comments });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function statusAction(post: AdminPost) {
    const next = post.status === "VISIBLE" ? "HIDDEN" : "VISIBLE";
    return (
      <button
        className="btn sm ghost"
        disabled={busy}
        onClick={() =>
          void act(
            () => api.patch(`/api/admin/community/posts/${post.id}`, { status: next, note: `Status set to ${next} by ${user?.name ?? "moderator"}` }),
            next === "HIDDEN" ? "Post hidden from the community." : "Post restored to the community.",
          )
        }
      >
        {next === "HIDDEN" ? "Hide" : "Restore"}
      </button>
    );
  }

  return (
    <div className="fade-in">
      <div className="row-between" style={{ marginBottom: 18 }}>
        <div>
          <h2>Community moderation</h2>
          <p className="small muted" style={{ marginTop: 4 }}>
            Review posts and comments, correct personal identifiers, hide harmful threads or remove them entirely. Every action is audited.
          </p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <Badge tone="ok">{data?.counts.visible ?? 0} visible</Badge>
          <Badge tone="warn">{data?.counts.hidden ?? 0} hidden</Badge>
          <Badge tone="muted">{data?.counts.comments ?? 0} comments</Badge>
        </div>
      </div>

      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      <div className="filter-bar">
        <div className="field">
          <label htmlFor="status-filter">Status</label>
          <select id="status-filter" className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All posts</option>
            <option value="VISIBLE">Visible</option>
            <option value="HIDDEN">Hidden</option>
            <option value="REMOVED">Soft-removed</option>
          </select>
        </div>
        <form
          className="row"
          style={{ gap: 6 }}
          onSubmit={(e) => {
            e.preventDefault();
            setSearch((s) => ({ ...s, applied: s.input.trim() }));
          }}
        >
          <input className="input" value={search.input} onChange={(e) => setSearch({ ...search, input: e.target.value })} placeholder="Search title, body or author" aria-label="Search community posts" />
          <button className="btn sm" type="submit"><Icon name="search" size={14} /> Search</button>
        </form>
      </div>

      <Card flush>
        {!data && <div style={{ padding: 20 }}><Spinner /></div>}
        {data && data.posts.length === 0 && <EmptyState title="No posts match this view." hint="Try clearing the filters." />}
        {data && data.posts.length > 0 && (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Post</th><th>Author</th><th>Status</th><th>Comments</th><th>Created</th><th></th></tr>
              </thead>
              <tbody>
                {data.posts.map((post) => (
                  <tr key={post.id}>
                    <td style={{ maxWidth: 380 }}>
                      <div className="strong">{post.title}</div>
                      <div className="cell-sub">{post.topic} · {post.id}</div>
                    </td>
                    <td>
                      <div>{post.authorName}</div>
                      <div className="cell-sub">{post.isGuest ? "Guest" : "Signed-in account"}</div>
                    </td>
                    <td>
                      <Badge tone={STATUS_TONE[post.status] ?? "muted"}>{post.status}</Badge>
                      {post.editedAt && <div className="cell-sub">edited {timeAgo(post.editedAt)}</div>}
                    </td>
                    <td>
                      {post.commentCount}
                      {Boolean(post.hiddenComments) && <span className="cell-sub"> ({post.hiddenComments} hidden)</span>}
                    </td>
                    <td className="nowrap">{formatDate(post.createdAt, { hour: "2-digit", minute: "2-digit" })}</td>
                    <td className="right nowrap">
                      <button className="btn sm ghost" onClick={() => void openDetails(post)}>Comments</button>
                      <button
                        className="btn sm ghost"
                        style={{ marginLeft: 4 }}
                        onClick={() => setEdit({ post, title: post.title, body: post.body, topic: post.topic, note: "", pinned: post.pinned })}
                      >
                        Edit
                      </button>
                      <span style={{ marginLeft: 4 }}>{statusAction(post)}</span>
                      <button
                        className="btn sm ghost"
                        style={{ marginLeft: 4, color: "var(--danger)" }}
                        disabled={busy}
                        onClick={() =>
                          confirmRemove === post.id
                            ? void act(() => api.delete(`/api/admin/community/posts/${post.id}`), "Post and its comments permanently removed.")
                            : setConfirmRemove(post.id)
                        }
                      >
                        {confirmRemove === post.id ? "Confirm?" : "Remove"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {edit && (
        <Modal
          title="Edit post"
          sub={`${edit.post.authorName} · ${edit.post.id}`}
          onClose={() => setEdit(null)}
        >
          <div className="form-grid">
            <div className="field">
              <label htmlFor="edit-topic">Topic</label>
              <select id="edit-topic" className="select" value={edit.topic} onChange={(e) => setEdit({ ...edit, topic: e.target.value })}>
                {(topics.length ? topics : [edit.topic]).map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="edit-title">Title</label>
              <input id="edit-title" className="input" value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
            </div>
            <div className="field full">
              <label htmlFor="edit-body">Body</label>
              <textarea id="edit-body" className="textarea" value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} />
            </div>
            <div className="field full">
              <label htmlFor="edit-note">Moderation note (shown in the audit log)</label>
              <input id="edit-note" className="input" maxLength={300} value={edit.note} onChange={(e) => setEdit({ ...edit, note: e.target.value })} placeholder="e.g. removed a phone number" />
            </div>
          </div>
          <label className="check">
            <input type="checkbox" checked={edit.pinned} onChange={(e) => setEdit({ ...edit, pinned: e.target.checked })} />
            <span>Pin this post to the top of the community feed</span>
          </label>
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setEdit(null)}>Cancel</button>
            <button
              className="btn primary"
              disabled={busy || edit.title.trim().length < 8 || edit.body.trim().length < 20}
              onClick={() =>
                void act(async () => {
                  await api.patch(`/api/admin/community/posts/${edit.post.id}`, {
                    title: edit.title,
                    body: edit.body,
                    topic: edit.topic,
                    pinned: edit.pinned,
                    note: edit.note || "Content edited by moderator",
                  });
                  setEdit(null);
                }, "Post updated.")
              }
            >
              {busy ? <span className="spinner" /> : "Save changes"}
            </button>
          </div>
        </Modal>
      )}

      {details && (
        <Modal title="Comments" sub={`${details.post.title} · ${details.comments.length} comments`} onClose={() => { setDetails(null); setCommentEdit(null); }}>
          {details.comments.length === 0 && <EmptyState title="No comments on this post." />}
          <div className="stack" style={{ gap: 12 }}>
            {details.comments.map((comment) => (
              <div key={comment.id} style={{ border: "1px solid var(--line)", borderRadius: 9, padding: "10px 12px" }}>
                <div className="row-between" style={{ marginBottom: 6 }}>
                  <div className="row" style={{ gap: 6 }}>
                    <strong className="small">{comment.authorName}</strong>
                    <Badge tone={STATUS_TONE[comment.status] ?? "muted"}>{comment.status}</Badge>
                    {comment.isGuest && <Badge tone="muted">Guest</Badge>}
                    <span className="tiny faint">{timeAgo(comment.createdAt)}</span>
                  </div>
                  <div className="row" style={{ gap: 4 }}>
                    <button
                      className="btn sm ghost"
                      onClick={() => setCommentEdit(commentEdit?.id === comment.id ? null : { id: comment.id, body: comment.body, note: "" })}
                    >
                      Edit
                    </button>
                    <button
                      className="btn sm ghost"
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          await api.patch(`/api/admin/community/comments/${comment.id}`, {
                            status: comment.status === "VISIBLE" ? "HIDDEN" : "VISIBLE",
                            note: "Comment visibility changed by moderator",
                          });
                          await reloadDetails(details.post.id);
                        }, comment.status === "VISIBLE" ? "Comment hidden." : "Comment restored.")
                      }
                    >
                      {comment.status === "VISIBLE" ? "Hide" : "Restore"}
                    </button>
                    <button
                      className="btn sm ghost"
                      style={{ color: "var(--danger)" }}
                      disabled={busy}
                      onClick={() =>
                        confirmRemove === comment.id
                          ? void act(async () => {
                              await api.delete(`/api/admin/community/comments/${comment.id}`);
                              await reloadDetails(details.post.id);
                            }, "Comment removed.")
                          : setConfirmRemove(comment.id)
                      }
                    >
                      {confirmRemove === comment.id ? "Confirm?" : "Remove"}
                    </button>
                  </div>
                </div>
                {commentEdit?.id === comment.id ? (
                  <>
                    <textarea className="textarea" style={{ minHeight: 80 }} value={commentEdit.body} onChange={(e) => setCommentEdit({ ...commentEdit, body: e.target.value })} />
                    <div className="row" style={{ gap: 6, marginTop: 8 }}>
                      <input className="input" style={{ flex: 1 }} placeholder="Moderation note" value={commentEdit.note} onChange={(e) => setCommentEdit({ ...commentEdit, note: e.target.value })} />
                      <button
                        className="btn sm primary"
                        disabled={busy || commentEdit.body.trim().length < 2}
                        onClick={() =>
                          void act(async () => {
                            await api.patch(`/api/admin/community/comments/${comment.id}`, { body: commentEdit.body, note: commentEdit.note || "Comment edited by moderator" });
                            setCommentEdit(null);
                            await reloadDetails(details.post.id);
                          }, "Comment updated.")
                        }
                      >
                        Save
                      </button>
                      <button className="btn sm ghost" onClick={() => setCommentEdit(null)}>Cancel</button>
                    </div>
                  </>
                ) : (
                  <p className="prose small">{comment.body}</p>
                )}
              </div>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}
