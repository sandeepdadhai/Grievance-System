import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, formatDate, slaCountdown, statusLabel } from "../api";
import { useAuth } from "../auth";
import type { ChatCaseStatus, ChatResponse } from "../types";
import { Badge, Icon, PriorityBadge } from "./ui";

type Message = {
  id: number;
  role: "user" | "assistant";
  text: string;
  caseStatus?: ChatCaseStatus;
  suggestions?: Array<{ label: string; href: string }>;
  emergency?: boolean;
};

const QUICK = ["How do I file a grievance?", "What documents should I attach?", "How long does a case take?", "Check my case status"];

export function ChatWidget() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [caseId, setCaseId] = useState("");
  const [accessCode, setAccessCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<Message[]>([
    {
      id: 1,
      role: "assistant",
      text: user?.baseRole === "PATIENT"
        ? `Hello ${user.name.split(" ")[0]}. I can explain how grievances work or summarise one of your cases. What do you need?`
        : "Hello. I can explain grievance intake, deadlines, documents, privacy and escalation, or check a case status with a reference and access code. What do you need?",
    },
  ]);
  const nextId = useRef(2);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages, open]);

  async function send(text: string) {
    if (!text.trim() || busy) return;
    setMessages((prev) => [...prev, { id: nextId.current++, role: "user", text: text.trim() }]);
    setInput("");
    setBusy(true);
    try {
      const res = await api.post<ChatResponse>("/api/chat", {
        message: text.trim(),
        caseId: caseId.trim() || undefined,
        accessCode: accessCode.trim() || undefined,
      });
      setMessages((prev) => [
        ...prev,
        {
          id: nextId.current++,
          role: "assistant",
          text: res.reply,
          caseStatus: res.caseStatus,
          suggestions: res.suggestions,
          emergency: res.emergency,
        },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { id: nextId.current++, role: "assistant", text: (err as Error).message || "Something went wrong. Please try again." },
      ]);
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void send(input);
  }

  if (!open) {
    return (
      <button className="chat-fab" type="button" onClick={() => setOpen(true)} aria-label="Open the MedNotice assistant">
        <Icon name="clipboard" size={19} />
        <span>Ask MedNotice</span>
      </button>
    );
  }

  return (
    <div className="chat-panel" role="dialog" aria-label="MedNotice assistant">
      <div className="chat-head">
        <div>
          <strong>MedNotice assistant</strong>
          <span>Case status &amp; general queries</span>
        </div>
        <button className="btn ghost icon-btn" type="button" onClick={() => setOpen(false)} aria-label="Close assistant">
          <Icon name="x" size={16} />
        </button>
      </div>

      <div className="chat-log" ref={logRef}>
        {messages.map((m) => (
          <div key={m.id} className={`chat-msg ${m.role}`}>
            <p>{m.text}</p>
            {m.caseStatus && (
              <div className="chat-case">
                <div className="row" style={{ gap: 6, marginBottom: 6 }}>
                  <span className="case-id">{m.caseStatus.id}</span>
                  <PriorityBadge priority={m.caseStatus.priority} />
                </div>
                <div className="small">{statusLabel(m.caseStatus.status)} · {m.caseStatus.category}</div>
                <div className="tiny faint" style={{ marginTop: 4 }}>
                  {m.caseStatus.facilityName ?? "Facility"} · verification {m.caseStatus.verificationStatus}
                </div>
                <div className="tiny faint" style={{ marginTop: 4 }}>
                  Submitted {formatDate(m.caseStatus.createdAt, { hour: undefined, minute: undefined })} ·{" "}
                  {m.caseStatus.resolvedAt ? "closed" : slaCountdown(m.caseStatus.slaDueAt).text} · {m.caseStatus.documents} document(s)
                </div>
                {m.caseStatus.lastEvent && <div className="tiny faint" style={{ marginTop: 4 }}>Last update: {m.caseStatus.lastEvent}</div>}
              </div>
            )}
            {m.emergency && <Badge tone="bad">Emergency guidance</Badge>}
            {m.suggestions && m.suggestions.length > 0 && (
              <div className="chat-suggestions">
                {m.suggestions.map((s) => (
                  <Link key={`${m.id}-${s.href}`} to={s.href} className="btn sm ghost" onClick={() => setOpen(false)}>
                    {s.label}
                  </Link>
                ))}
              </div>
            )}
          </div>
        ))}
        {busy && <div className="chat-msg assistant"><p className="faint">Checking…</p></div>}
      </div>

      <div className="chat-quick">
        {QUICK.map((q) => (
          <button key={q} type="button" className="chip" disabled={busy} onClick={() => void send(q)}>
            {q}
          </button>
        ))}
      </div>

      <div className="chat-lookup">
        <input className="input" value={caseId} onChange={(e) => setCaseId(e.target.value.toUpperCase())} placeholder="Case ref (CASE-2026-…)" aria-label="Case reference for status lookup" />
        <input className="input" value={accessCode} onChange={(e) => setAccessCode(e.target.value.toUpperCase())} placeholder="Access code" aria-label="Case access code" />
      </div>

      <form className="chat-input" onSubmit={onSubmit}>
        <input
          className="input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about a grievance or type a question"
          aria-label="Message the assistant"
          maxLength={600}
        />
        <button className="btn primary sm" type="submit" disabled={busy || !input.trim()} aria-label="Send message">
          <Icon name="send" size={14} />
        </button>
      </form>
      <p className="chat-foot">Automated assistant — not medical advice. Emergencies: call 108 or 112.</p>
    </div>
  );
}
