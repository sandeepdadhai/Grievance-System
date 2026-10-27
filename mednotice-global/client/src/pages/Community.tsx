import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, timeAgo } from "../api";
import { useAuth } from "../auth";
import type { CommunityPost } from "../types";
import { Alert, Badge, Card, EmptyState, Icon, Spinner } from "../components/ui";

type Feed = {
  posts: CommunityPost[];
  total: number;
  topics: string[];
  guidelines: string[];
};

export default function Community() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [feed, setFeed] = useState<Feed | null>(null);
  const [topic, setTopic] = useState("");
  const [query, setQuery] = useState({ input: "", applied: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ title: "", body: "", topic: "General", authorName: "", guidelines: false });

  async function load(nextTopic = topic, nextQuery = query.applied) {
    try {
      const params = new URLSearchParams();
      if (nextTopic) params.set("topic", nextTopic);
      if (nextQuery) params.set("q", nextQuery);
      const res = await api.get<Feed>(`/api/community/posts?${params.toString()}`);
      setFeed(res);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    void load(topic, query.applied);
  }, [topic, query.applied]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ post: CommunityPost }>("/api/community/posts", {
        title: form.title,
        body: form.body,
        topic: form.topic,
        guidelines: form.guidelines,
        authorName: user ? undefined : form.authorName,
      });
      setForm({ title: "", body: "", topic: "General", authorName: "", guidelines: false });
      navigate(`/community/${res.post.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section" style={{ maxWidth: 1180 }}>
      <div className="section-head">
        <span className="eyebrow">Community</span>
        <h2>Experiences, questions and feedback</h2>
        <p>
          Read what other patients and guests have run into, ask about documents or timelines, and share how your grievance
          was handled. Post as yourself or with a display name — no account needed.
        </p>
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      <div className="community-grid">
        <div className="stack">
          <Card>
            <form onSubmit={submit}>
              <div className="card-head">
                <h3><Icon name="plus" size={16} /> Start a post</h3>
                <span className="card-sub">{user ? `Posting as ${user.name}` : "Posting as a guest"}</span>
              </div>
              <div className="form-grid">
                <div className="field">
                  <label htmlFor="post-topic">Topic</label>
                  <select id="post-topic" className="select" value={form.topic} onChange={(e) => setForm({ ...form, topic: e.target.value })}>
                    {(feed?.topics ?? ["General"]).map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                {!user && (
                  <div className="field">
                    <label htmlFor="post-author">Display name</label>
                    <input id="post-author" className="input" maxLength={40} value={form.authorName} onChange={(e) => setForm({ ...form, authorName: e.target.value })} placeholder="e.g. Guest from Nagpur" required />
                  </div>
                )}
                <div className="field full">
                  <label htmlFor="post-title">Title</label>
                  <input id="post-title" className="input" maxLength={140} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Summarise the issue in one line" required />
                </div>
                <div className="field full">
                  <label htmlFor="post-body">Details</label>
                  <textarea id="post-body" className="textarea" maxLength={4000} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} placeholder="What happened, and what would you like others to know?" required />
                  <span className="hint">{form.body.length}/4000 · Do not include names, phone numbers or ID numbers.</span>
                </div>
              </div>
              <label className="check">
                <input type="checkbox" checked={form.guidelines} onChange={(e) => setForm({ ...form, guidelines: e.target.checked })} />
                <span>I have read the guidelines and confirm this post is my own experience.</span>
              </label>
              <button className="btn primary" type="submit" disabled={busy || !form.guidelines || form.title.trim().length < 8 || form.body.trim().length < 20}>
                {busy ? <span className="spinner" /> : "Publish post"}
              </button>
            </form>
          </Card>

          <div className="row-between">
            <div className="row" style={{ gap: 6 }}>
              <button className={`btn sm ${topic === "" ? "primary" : "ghost"}`} onClick={() => setTopic("")} type="button">All topics</button>
              {(feed?.topics ?? []).map((t) => (
                <button key={t} className={`btn sm ${topic === t ? "primary" : "ghost"}`} onClick={() => setTopic(t)} type="button">{t}</button>
              ))}
            </div>
            <form
              className="row"
              style={{ gap: 6 }}
              onSubmit={(e) => {
                e.preventDefault();
                setQuery((q) => ({ ...q, applied: q.input.trim() }));
              }}
            >
              <input className="input" style={{ minWidth: 180 }} value={query.input} onChange={(e) => setQuery({ ...query, input: e.target.value })} placeholder="Search posts" aria-label="Search community posts" />
              <button className="btn sm" type="submit"><Icon name="search" size={14} /></button>
            </form>
          </div>

          {!feed && <Spinner />}
          {feed && feed.posts.length === 0 && (
            <Card><EmptyState title="No posts match this filter yet." hint="Start the conversation above." /></Card>
          )}
          {feed?.posts.map((post) => (
            <Card key={post.id}>
              <div className="row" style={{ gap: 6, marginBottom: 8 }}>
                <Badge tone="info">{post.topic}</Badge>
                {post.pinned && <Badge tone="warn">Pinned</Badge>}
                {post.isGuest ? <Badge tone="muted">Guest</Badge> : <Badge tone="ok">Patient</Badge>}
                {post.isMine && <Badge tone="muted">Your post</Badge>}
              </div>
              <h3 style={{ fontSize: "1.02rem", marginBottom: 6 }}>
                <Link to={`/community/${post.id}`}>{post.title}</Link>
              </h3>
              <p className="small muted" style={{ marginBottom: 10 }}>
                {post.body.length > 240 ? `${post.body.slice(0, 240).trimEnd()}…` : post.body}
              </p>
              <div className="row-between tiny faint">
                <span>{post.authorName} · {timeAgo(post.createdAt)}{post.editedAt ? " · edited by moderator" : ""}</span>
                <Link to={`/community/${post.id}`} className="btn sm ghost">
                  {post.commentCount} comment{post.commentCount === 1 ? "" : "s"} <Icon name="chevron" size={12} />
                </Link>
              </div>
            </Card>
          ))}
        </div>

        <aside className="stack">
          <Card>
            <div className="card-head"><h3>Community guidelines</h3></div>
            <ol className="rule-list">
              {(feed?.guidelines ?? []).map((rule) => <li key={rule}>{rule}</li>)}
            </ol>
            <div className="divider" />
            <p className="tiny faint">
              Moderators can edit, hide or remove content. Removal decisions are recorded in the platform audit log.
            </p>
          </Card>
          <Card>
            <div className="card-head"><h3>Need case-specific help?</h3></div>
            <p className="small muted">The assistant can check a case status with your reference and access code, or explain how intake works.</p>
            <div className="stack" style={{ gap: 8, marginTop: 12 }}>
              <Link to="/track" className="btn sm">Track a case</Link>
              <Link to="/submit" className="btn sm ghost">File a grievance</Link>
              {!user && <Link to="/signup" className="btn sm ghost">Create a patient account</Link>}
            </div>
          </Card>
        </aside>
      </div>
    </section>
  );
}
