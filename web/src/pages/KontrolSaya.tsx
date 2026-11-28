import { useState } from "react";
import { api } from "../api";
import type { Ctx } from "../ui";
import { Empty, PageHead, Sev, Status, fmtDate, inDays, useAction, useLoad } from "../ui";

type Ev = { id: string; filename: string; description: string | null; state: string; uploaded_at: string | null; review_rationale: string | null };
type OwnedControl = {
  id: string; title: string; source_changed: boolean; status: "NEEDS_EVIDENCE" | "PENDING_REVIEW" | "ACCEPTED" | "EFFECTIVE";
  signed_off_at: string | null; evidence: { total: number; accepted: number; pending: number; rejected: number };
  evidence_items: Ev[];
  obligations: { obligation_id: string; summary: string; provision_version_id: string; number_label: string; canonical_number: string; version_number: number }[];
};
type Act = {
  id: string; description: string; state: string; due_date: string; original_due_date: string; overdue: boolean; owner_id: string | null;
  extension_history: { from: string; to: string; reason: string; at: string }[];
  evidence: { id: string; filename: string; state: string; review_rationale: string | null }[];
};
type OwnedFinding = {
  id: string; title: string; severity: string; state: string; source_type: string; created_at: string; target_closure_date: string | null;
  raised_by: string | null; needs_plan: boolean; actions: Act[];
};
type Summary = { controls: number; needs_evidence: number; pending_review: number; open_findings: number; needs_plan: number;
  overdue_actions: number; due_soon_actions: number; due_soon_days: number };
type Workspace = { summary: Summary; controls: OwnedControl[]; findings: OwnedFinding[] };

const WINDOW: Record<string, number> = { CRITICAL: 30, HIGH: 60, MEDIUM: 90, LOW: 180 };
const SOURCE: Record<string, string> = { COVERAGE_GAP: "Dari pindaian kesenjangan", ASSESSMENT: "Dari hasil asesmen", EVIDENCE_GAP: "Bukti tidak tersedia", MANUAL: "Dicatat manual" };
const BADGE: Record<OwnedControl["status"], [string, string]> = {
  NEEDS_EVIDENCE: ["Bukti diminta", "amber"], PENDING_REVIEW: ["Menunggu tinjauan", "blue"],
  ACCEPTED: ["Bukti diterima · menunggu asesmen", "teal"], EFFECTIVE: ["Efektif · bukti diterima", "green"],
};
const plusDays = (iso: string, n: number) => new Date(Date.parse(iso + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

function Stat({ label, value, note, tone }: { label: string; value: number; note: string; tone?: "low" | "ok" }) {
  return <div className="kpi"><span className="kpi-label">{label}</span><b className={`kpi-value ${tone || ""}`}>{value}</b><span className="kpi-note">{note}</span></div>;
}

export function KontrolSaya({ ctx }: { ctx: Ctx }) {
  const [w, reload] = useLoad<Workspace>(() => api("/compliance/owner/workspace"), [], ctx.notify);
  if (!w) return <div className="panel">Memuat kontrol Anda…</div>;
  const s = w.summary;
  const urgent = s.overdue_actions > 0;

  return <>
    <PageHead crumbs="Kepatuhan · Risiko & kontrol" title="Kontrol saya"
      intro="Kontrol yang Anda miliki, beserta bukti yang perlu diunggah dan temuan yang perlu diperbaiki." />

    {(urgent || s.due_soon_actions > 0 || s.needs_plan > 0) && <div className={`notice ${urgent ? "error" : "warn"}`} role="alert">
      <span>
        {urgent && <><b>{s.overdue_actions} tindakan remediasi lewat tenggat.</b> Selesaikan atau ajukan perpanjangan dengan alasan. </>}
        {s.due_soon_actions > 0 && <>{s.due_soon_actions} tindakan jatuh tempo dalam {s.due_soon_days} hari. </>}
        {s.needs_plan > 0 && <>{s.needs_plan} temuan belum punya rencana remediasi.</>}
      </span>
    </div>}

    <div className="kpi-grid">
      <Stat label="Kontrol saya" value={s.controls} note="kontrol yang Anda miliki" />
      <Stat label="Perlu bukti" value={s.needs_evidence} tone={s.needs_evidence ? "low" : "ok"} note={`${s.pending_review} menunggu tinjauan`} />
      <Stat label="Temuan terbuka" value={s.open_findings} tone={s.open_findings ? "low" : "ok"} note={`${s.needs_plan} perlu rencana`} />
      <Stat label="Tindakan terlambat" value={s.overdue_actions} tone={s.overdue_actions ? "low" : "ok"} note={`${s.due_soon_actions} jatuh tempo ≤ ${s.due_soon_days} hari`} />
    </div>

    <div className="cols">
      <div>
        {w.controls.length ? w.controls.map(c => <ControlCard key={c.id} c={c} ctx={ctx} onDone={reload} />)
          : <section className="panel"><Empty>Belum ada kontrol yang ditetapkan kepada Anda. Hubungi Pejabat Kepatuhan.</Empty></section>}
        {s.needs_evidence === 0 && w.controls.length > 0 && <p className="small muted">Tidak ada kontrol yang menunggu bukti dari Anda.</p>}
      </div>
      <aside>
        <section className="panel">
          <div className="between"><h2 style={{ margin: 0 }}>Temuan untuk Anda</h2>
            <span className={`badge ${w.findings.length ? "red" : "green"}`}>{w.findings.length ? `${w.findings.length} terbuka` : "Tidak ada"}</span></div>
          {w.findings.length ? w.findings.map(f => <FindingCard key={f.id} f={f} ctx={ctx} onDone={reload} />)
            : <Empty>Tidak ada temuan terbuka atas nama Anda.</Empty>}
        </section>
      </aside>
    </div>
  </>;
}

function ControlCard({ c, ctx, onDone }: { c: OwnedControl; ctx: Ctx; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [desc, setDesc] = useState("");
  const { run, busy } = useAction(ctx.notify, () => { setFile(null); setDesc(""); onDone(); });
  const [label, tone] = BADGE[c.status];
  const askEvidence = c.status === "NEEDS_EVIDENCE" || c.source_changed;

  const send = () => file && run(async () => {
    const form = new FormData(); form.append("file", file); form.append("description", desc);
    await api(`/compliance/controls/${c.id}/evidence`, { form });
  }, "Bukti terkirim dan menunggu tinjauan Pejabat Kepatuhan.");

  return <section className="panel">
    <div className="between"><h2 style={{ margin: 0 }}>{c.title}</h2><span className={`badge ${tone}`}>{label}</span></div>
    <p className="small muted" style={{ margin: "4px 0 0" }}>
      {c.obligations.length ? `${c.obligations.length} kewajiban terkait` : "Belum dipetakan ke kewajiban."}
      {c.status === "EFFECTIVE" && c.signed_off_at && <> · asesmen terakhir disetujui manajer {fmtDate(c.signed_off_at)}</>}
      {c.evidence.pending > 0 && <> · {c.evidence.pending} bukti menunggu tinjauan</>}
      {c.evidence.rejected > 0 && c.status === "NEEDS_EVIDENCE" && <> · {c.evidence.rejected} bukti ditolak, unggah ulang</>}
    </p>
    {c.source_changed && <div className="notice warn" style={{ marginTop: 10, marginBottom: 0 }}><span>Pasal sumber berubah material. Unggah bukti terbaru agar kontrol dapat diasesmen ulang.</span></div>}

    {/* Semua kewajiban yang dijalankan kontrol ini (PDF: owner "meninjau kewajiban relevan") */}
    {c.obligations.length > 0 && <details style={{ marginTop: 10 }} open={c.obligations.length === 1}>
      <summary className="small" style={{ cursor: "pointer" }}>Kewajiban yang dipenuhi kontrol ini ({c.obligations.length})</summary>
      <ul className="list" style={{ marginTop: 6 }}>{c.obligations.map(o => <li key={o.obligation_id}>
        <button type="button" className="cite" onClick={() => ctx.openCite(o.provision_version_id)}>{o.canonical_number} v{o.version_number} {o.number_label}</button>
        <div className="small muted">{o.summary}</div>
      </li>)}</ul>
    </details>}

    {/* Riwayat bukti: status tiap berkas dan alasan penolakan */}
    {c.evidence_items.length > 0 && <details style={{ marginTop: 8 }} open={c.evidence.rejected > 0}>
      <summary className="small" style={{ cursor: "pointer" }}>Riwayat bukti ({c.evidence.total})</summary>
      <ul className="list" style={{ marginTop: 6 }}>{c.evidence_items.map(e => <li key={e.id}>
        <div className="between"><span className="small">{e.filename}</span><Status s={e.state} /></div>
        <div className="small muted">{e.description || "tanpa keterangan"} · {fmtDate(e.uploaded_at)}</div>
        {e.state === "REJECTED" && e.review_rationale && <div className="small" style={{ color: "var(--red)" }}>Alasan ditolak: {e.review_rationale}</div>}
      </li>)}</ul>
    </details>}

    {askEvidence && <div className="form" style={{ marginTop: 14 }}>
      <div className="dropzone">
        <div><b>Unggah bukti</b><div className="small muted">{file ? `${file.name} · ${(file.size / 1024).toFixed(0)} KB` : "PDF, gambar, atau CSV"}</div></div>
        <label className="btn" style={{ cursor: "pointer" }}>Pilih file<input type="file" hidden accept=".pdf,.png,.jpg,.jpeg,.csv" onChange={e => setFile(e.target.files?.[0] || null)} /></label>
      </div>
      <label className="field">Keterangan bukti<input value={desc} onChange={e => setDesc(e.target.value)} placeholder="mis. Berita acara serah terima, 15 Des 2026" /></label>
      <div><button className="btn primary" disabled={busy || !file} onClick={send}>Kirim bukti untuk ditinjau</button></div>
    </div>}
  </section>;
}

function FindingCard({ f, ctx, onDone }: { f: OwnedFinding; ctx: Ctx; onDone: () => void }) {
  const win = WINDOW[f.severity] ?? 30;
  const [plan, setPlan] = useState("");
  const [due, setDue] = useState(inDays(Math.min(14, win)));
  const { run, busy } = useAction(ctx.notify, onDone);
  const live = f.actions.filter(a => a.state !== "CANCELLED");

  return <div className="owner-finding">
    <div className="between"><b>{f.title}</b><Sev s={f.severity} /></div>
    <div className="small muted">{SOURCE[f.source_type] || f.source_type}{f.raised_by ? ` ${f.raised_by}` : ""} · {fmtDate(f.created_at)} · target {fmtDate(f.target_closure_date)}</div>

    {f.needs_plan && <div className="form" style={{ marginTop: 10 }}>
      <label className="field">Rencana remediasi<textarea value={plan} onChange={e => setPlan(e.target.value)} placeholder="Langkah perbaikan" /></label>
      <label className="field">Tenggat<input type="date" value={due} min={inDays(0)} max={inDays(win)} onChange={e => setDue(e.target.value)} /></label>
      <span className="hint">Maksimal {win} hari untuk tingkat {f.severity}.</span>
      <div><button className="btn primary" disabled={busy || !plan.trim() || !due}
        onClick={() => run(() => api(`/compliance/owner/findings/${f.id}/plan`, { body: { description: plan.trim(), due_date: due } }), "Rencana remediasi tersimpan.")}>Simpan rencana</button></div>
    </div>}

    {live.length > 0 && <ul className="list" style={{ marginTop: 8 }}>{live.map(a => <ActionRow key={a.id} a={a} mine={a.owner_id === ctx.me.user_id} ctx={ctx} onDone={onDone} />)}</ul>}
    {live.length > 0 && <button className="btn ghost sm" onClick={() => ctx.go(`temuan/${f.id}`)}>Lihat detail temuan →</button>}
  </div>;
}

/** Satu tindakan remediasi: mulai, unggah bukti penutupan, ajukan perpanjangan, selesaikan (semua endpoint sudah ada). */
function ActionRow({ a, mine, ctx, onDone }: { a: Act; mine: boolean; ctx: Ctx; onDone: () => void }) {
  const [mode, setMode] = useState<"" | "evidence" | "extend" | "complete">("");
  const [file, setFile] = useState<File | null>(null);
  const [desc, setDesc] = useState("");
  const [newDue, setNewDue] = useState(plusDays(a.due_date, 14));
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const { run, busy } = useAction(ctx.notify, () => { setMode(""); setFile(null); setDesc(""); setReason(""); setNote(""); onDone(); });
  const active = a.state === "OPEN" || a.state === "IN_PROGRESS";
  const accepted = a.evidence.some(e => e.state === "ACCEPTED");
  const pending = a.evidence.some(e => e.state === "SUBMITTED");
  const rejected = a.evidence.filter(e => e.state === "REJECTED" && e.review_rationale);

  return <li>
    <div className="between"><span className="small">{a.description}</span><Status s={a.state} /></div>
    <div className="small muted" style={a.overdue ? { color: "var(--red)", fontWeight: 600 } : undefined}>
      Tenggat {fmtDate(a.due_date)}{a.overdue ? " (terlambat)" : ""}
      {a.due_date !== a.original_due_date && <span style={{ fontWeight: 400 }}> · semula {fmtDate(a.original_due_date)}, diperpanjang {a.extension_history.length}×</span>}
    </div>
    {a.evidence.length > 0 && <div className="small muted">
      Bukti penutupan: {a.evidence.length} berkas{accepted ? " · ada yang diterima" : pending ? " · menunggu tinjauan Pejabat" : ""}
    </div>}
    {rejected.map(e => <div key={e.id} className="small" style={{ color: "var(--red)" }}>Ditolak ({e.filename}): {e.review_rationale}</div>)}

    {mine && active && mode === "" && <div className="row" style={{ marginTop: 6, gap: 6, flexWrap: "wrap" }}>
      {a.state === "OPEN" && <button className="btn sm" disabled={busy}
        onClick={() => run(() => api(`/compliance/actions/${a.id}/start`, { method: "POST" }), "Tindakan ditandai berjalan.")}>Mulai kerjakan</button>}
      <button className="btn sm" onClick={() => setMode("evidence")}>Unggah bukti penutupan</button>
      <button className="btn sm" onClick={() => setMode("extend")}>Ajukan perpanjangan</button>
      <button className="btn sm" disabled={!accepted} title={accepted ? "" : "Perlu minimal satu bukti penutupan yang diterima Pejabat Kepatuhan"}
        onClick={() => setMode("complete")}>Tandai selesai</button>
    </div>}

    {mode === "evidence" && <div className="form" style={{ marginTop: 8 }}>
      <div className="dropzone">
        <div><b>Bukti penutupan</b><div className="small muted">{file ? `${file.name} · ${(file.size / 1024).toFixed(0)} KB` : "PDF, gambar, atau CSV"}</div></div>
        <label className="btn" style={{ cursor: "pointer" }}>Pilih file<input type="file" hidden accept=".pdf,.png,.jpg,.jpeg,.csv" onChange={e => setFile(e.target.files?.[0] || null)} /></label>
      </div>
      <label className="field">Keterangan<input value={desc} onChange={e => setDesc(e.target.value)} placeholder="mis. Tangkapan layar konfigurasi baru" /></label>
      <div className="row" style={{ gap: 6 }}>
        <button className="btn primary sm" disabled={busy || !file} onClick={() => file && run(async () => {
          const form = new FormData(); form.append("file", file); form.append("description", desc);
          await api(`/compliance/actions/${a.id}/evidence`, { form });
        }, "Bukti penutupan terkirim dan menunggu tinjauan.")}>Kirim</button>
        <button className="btn ghost sm" onClick={() => setMode("")}>Batal</button>
      </div>
    </div>}

    {mode === "extend" && <div className="form" style={{ marginTop: 8 }}>
      <label className="field">Tenggat baru<input type="date" value={newDue} min={plusDays(a.due_date, 1)} onChange={e => setNewDue(e.target.value)} /></label>
      <label className="field">Alasan perpanjangan<textarea value={reason} onChange={e => setReason(e.target.value)} placeholder="Wajib diisi; tercatat di riwayat dan jejak audit" /></label>
      <div className="row" style={{ gap: 6 }}>
        <button className="btn primary sm" disabled={busy || !reason.trim() || newDue <= a.due_date}
          onClick={() => run(() => api(`/compliance/actions/${a.id}/extend`, { body: { new_due_date: newDue, reason: reason.trim() } }), "Tenggat diperpanjang; tanggal asli tetap tersimpan.")}>Simpan perpanjangan</button>
        <button className="btn ghost sm" onClick={() => setMode("")}>Batal</button>
      </div>
    </div>}

    {mode === "complete" && <div className="form" style={{ marginTop: 8 }}>
      <label className="field">Catatan penyelesaian<textarea value={note} onChange={e => setNote(e.target.value)} placeholder="Apa yang sudah dilakukan" /></label>
      <div className="row" style={{ gap: 6 }}>
        <button className="btn primary sm" disabled={busy}
          onClick={() => run(() => api(`/compliance/actions/${a.id}/complete`, { body: { note: note.trim() || null } }), "Tindakan selesai.")}>Tandai selesai</button>
        <button className="btn ghost sm" onClick={() => setMode("")}>Batal</button>
      </div>
    </div>}
  </li>;
}