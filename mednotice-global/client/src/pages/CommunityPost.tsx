import { useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { api, formatDate, timeAgo } from "../api";
import { useAuth } from "../auth";
import type { CommunityComment, CommunityPost } from "../types";
import { Alert, Badge, Card, EmptyState, Icon, Spinner } from "../components/ui";

export default function CommunityPostDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const [post, setPost] = useState<CommunityPost | null>(null);
  const [comments, setComments] = useState<CommunityComment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ body: "", authorName: "", guidelines: false });

  useEffect(() => {
    if (!id) return;
    api
      .get<{ post: CommunityPost; comments: CommunityComment[] }>(`/api/community/posts/${id}`)
      .then((res) => {
        setPost(res.post);
        setComments(res.comments);
      })
      .catch((err) => setError((err as Error).message));
  }, [id]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!post) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ comment: CommunityComment }>(`/api/community/posts/${post.id}/comments`, {
        body: form.body,
        guidelines: form.guidelines,
        authorName: user ? undefined : form.authorName,
      });
      setComments((prev) => [...prev, res.comment]);
      setForm({ body: "", authorName: "", guidelines: false });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section" style={{ maxWidth: 940 }}>
      <Link to="/community" className="small faint">← Back to community</Link>
      <div style={{ height: 14 }} />
      {error && <Alert tone="error">{error}</Alert>}
      {!post && !error && <Spinner />}

      {post && (
        <>
          <Card>
            <div className="row" style={{ gap: 6, marginBottom: 10 }}>
              <Badge tone="info">{post.topic}</Badge>
              {post.isGuest ? <Badge tone="muted">Guest post</Badge> : <Badge tone="ok">Patient post</Badge>}
              {post.pinned && <Badge tone="warn">Pinned</Badge>}
              {post.editedAt && <Badge tone="warn">Edited by moderator</Badge>}
            </div>
            <h1 style={{ fontSize: "1.6rem", marginBottom: 10 }}>{post.title}</h1>
            <p className="small faint" style={{ marginBottom: 16 }}>
              {post.authorName} · {formatDate(post.createdAt, { hour: "2-digit", minute: "2-digit" })} · {post.commentCount} comment{post.commentCount === 1 ? "" : "s"}
            </p>
            <p className="prose">{post.body}</p>
          </Card>

          <div className="section-subhead">
            <h2 style={{ fontSize: "1.1rem" }}>Comments</h2>
            <span className="small faint">{comments.length} visible</span>
          </div>

          {comments.length === 0 && <Card><EmptyState title="No comments yet." hint="Add the first reply below." /></Card>}
          <div className="stack">
            {comments.map((c) => (
              <Card key={c.id}>
                <div className="row" style={{ gap: 6, marginBottom: 8 }}>
                  <strong className="small">{c.authorName}</strong>
                  {c.isGuest ? <Badge tone="muted">Guest</Badge> : <Badge tone="ok">Patient</Badge>}
                  {c.isMine && <Badge tone="muted">You</Badge>}
                  <span className="tiny faint">· {timeAgo(c.createdAt)}{c.editedAt ? " · edited by moderator" : ""}</span>
                </div>
                <p className="prose small">{c.body}</p>
              </Card>
            ))}
          </div>

          <Card style={{ marginTop: 18 }}>
            <form onSubmit={submit}>
              <div className="card-head">
                <h3>Add a comment</h3>
                <span className="card-sub">{user ? `As ${user.name}` : "As a guest"}</span>
              </div>
              {!user && (
                <div className="field">
                  <label htmlFor="comment-author">Display name</label>
                  <input id="comment-author" className="input" maxLength={40} value={form.authorName} onChange={(e) => setForm({ ...form, authorName: e.target.value })} placeholder="e.g. Guest from Nagpur" required />
                </div>
              )}
              <div className="field">
                <label htmlFor="comment-body">Comment</label>
                <textarea id="comment-body" className="textarea" style={{ minHeight: 90 }} maxLength={1500} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} placeholder="Keep it about your own experience and avoid personal identifiers." required />
              </div>
              <label className="check">
                <input type="checkbox" checked={form.guidelines} onChange={(e) => setForm({ ...form, guidelines: e.target.checked })} />
                <span>I have read the community guidelines.</span>
              </label>
              <button className="btn primary" type="submit" disabled={busy || !form.guidelines || form.body.trim().length < 2}>
                {busy ? <span className="spinner" /> : <><Icon name="send" size={14} /> Post comment</>}
              </button>
            </form>
          </Card>
        </>
      )}
    </section>
  );
}
