import { useState } from "react";
import { api, download } from "../api";
import type { Ctx } from "../ui";
import { Empty, PageHead, Status, fmtDate, fmtTime, useAction, useLoad } from "../ui";

const TABS: [string, string][] = [["trace", "Ketertelusuran"], ["evidence", "Bukti"], ["complete", "Kelengkapan jejak audit"]];
const STATUS_TONE: Record<string, string> = { PASS: "green", WARN: "amber", FAIL: "red" };

export function Auditor({ ctx }: { ctx: Ctx }) {
  const [tab, setTab] = useState("trace");
  const [ov] = useLoad<any>(() => api("/compliance/auditor/overview"), [], ctx.notify);
  return <>
    <PageHead crumbs="Laporan & Audit" title="Ruang kerja auditor"
      intro="Telusuri rantai pasal → kewajiban → kontrol → bukti → temuan → laporan ke dua arah, verifikasi bukti, dan periksa kelengkapan jejak audit. Semua hanya baca." >
      <button className="btn" onClick={() => download("/audit/export", "rcip_audit_trail.csv").catch(e => ctx.notify("error", e.message))}>Ekspor jejak audit (CSV)</button>
    </PageHead>
    {ov && <div className="kpi-grid">
      <div className="kpi"><span className="kpi-label">Event audit</span><b className="kpi-value">{ov.audit_events}</b><span className="kpi-note">{ov.audit_events_30d} dalam 30 hari</span></div>
      <div className="kpi"><span className="kpi-label">Persetujuan maker-checker</span><b className="kpi-value">{ov.approvals}</b><span className="kpi-note">{ov.obligations_active} kewajiban aktif</span></div>
      <div className="kpi"><span className="kpi-label">Bukti</span><b className="kpi-value">{Object.values(ov.evidence_by_state as Record<string, number>).reduce((a, b) => a + b, 0)}</b>
        <span className="kpi-note">{Object.entries(ov.evidence_by_state).map(([k, v]) => `${k} ${v}`).join(" · ") || "—"}</span></div>
      <div className="kpi"><span className="kpi-label">Panggilan AI</span><b className="kpi-value">{ov.ai_calls}</b><span className="kpi-note">{ov.ai_calls_low_grounding} gagal skema/grounding</span></div>
    </div>}
    <div className="tabs" role="tablist">{TABS.map(([k, l]) => <button key={k} role="tab" className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>)}</div>
    {tab === "trace" && <Trace ctx={ctx} />}
    {tab === "evidence" && <EvidenceTab ctx={ctx} />}
    {tab === "complete" && <Completeness ctx={ctx} />}
  </>;
}

function Trace({ ctx }: { ctx: Ctx }) {
  const [reports] = useLoad<any[]>(() => api("/compliance/auditor/reports"), [], ctx.notify);
  const [rid, setRid] = useState("");
  const [rt, setRt] = useState<any>(null);
  const [obs] = useLoad<any[]>(() => api("/compliance/obligations"), [], ctx.notify);
  const [pv, setPv] = useState<any>(null);
  const rep = useAction(ctx.notify);
  const fwd = useAction(ctx.notify);
  return <div className="cols-even">
    <section className="panel">
      <header><div><h2>Laporan → pasal sumber</h2><p>Arah mundur: setiap butir laporan diresolusi ke versi peraturan terbit.</p></div></header>
      <div className="row"><select className="grow" value={rid} onChange={e => setRid(e.target.value)} aria-label="Pilih laporan">
        <option value="">Pilih laporan…</option>{(reports || []).map(r => <option key={r.id} value={r.id}>{r.title} · {r.state}</option>)}</select>
        <button className="btn primary" disabled={!rid || rep.busy} onClick={() => rep.run(async () => setRt(await api(`/compliance/auditor/trace/report/${rid}`)))}>Telusuri</button></div>
      {rt && <>
        <p className="small" style={{ marginTop: 12 }}><b>{rt.total}</b> butir · <span style={{ color: rt.unresolved ? "var(--red)" : "var(--green)" }}>{rt.unresolved} tidak terresolusi</span> · penanda keterlacakan laporan: {rt.traceability_flag ? "terverifikasi" : "tidak ada"}</p>
        <div className="tablewrap"><table className="data"><thead><tr><th>Butir</th><th>Pasal sumber</th><th>Versi</th><th>Status</th></tr></thead>
          <tbody>{rt.items.map((i: any) => <tr key={i.obligation_id}>
            <td className="small">{(i.summary || "").slice(0, 80)}<div className="muted">{i.coverage}</div></td>
            <td>{i.provision_version_id ? <button className="cite" onClick={() => ctx.openCite(i.provision_version_id)}>{i.canonical_number} {i.number_label}</button> : "—"}</td>
            <td className="small">v{i.version_number ?? "?"}<div className="muted">{fmtDate(i.effective_date)}</div></td>
            <td><span className={`badge ${i.resolved ? "green" : "red"}`}>{i.resolved ? "terresolusi" : i.version_state}</span></td></tr>)}</tbody></table></div></>}
    </section>
    <section className="panel">
      <header><div><h2>Pasal → status kepatuhan</h2><p>Arah maju: dari kewajiban ke persetujuan, kontrol, asesmen, bukti, dan temuan.</p></div></header>
      {obs?.length ? <ul className="list">{obs.slice(0, 40).map((o: any) => <li key={o.id} className="between small">
        <span>{(o.summary || "").slice(0, 70)}<div className="muted">{o.citation.canonical_number} {o.citation.number_label}</div></span>
        <button className="btn sm" disabled={fwd.busy} onClick={() => fwd.run(async () => setPv(await api(`/compliance/auditor/trace/provision/${o.citation.provision_version_id}`)))}>Telusuri</button></li>)}</ul> : <Empty>Belum ada kewajiban.</Empty>}
      {pv && <div className="verbatim" style={{ marginTop: 12 }}>
        <div className="between"><b>{pv.citation.document.canonical_number} — {pv.citation.number_label}</b><span className={`badge ${pv.status === "EFFECTIVE" ? "green" : pv.status === "NO_CONTROL" ? "red" : "amber"}`}>{pv.status}</span></div>
        {pv.obligations.map((c: any) => <div key={c.obligation.id} className="small" style={{ marginTop: 8 }}>
          <b>{c.obligation.summary}</b> <Status s={c.obligation.state} />
          <div className="muted">pemilik {c.obligation.owner || "—"} · validator {c.obligation.validator || "—"} · penyetuju {c.obligation.approver || "—"}{c.obligation.derived_from_ai ? " · draf AI" : ""}</div>
          {c.approvals.map((a: any, i: number) => <div key={i} className="muted">titik {a.control_point}: {a.outcome} oleh {a.checker} (maker {a.maker}) · {fmtTime(a.decided_at)}</div>)}
          {c.controls.map((k: any) => <div key={k.id}>Kontrol <b>{k.title}</b> ({k.owner || "tanpa pemilik"}): {k.latest_assessment ? `${k.latest_assessment.state} · desain ${k.latest_assessment.design_result || "—"} · operasi ${k.latest_assessment.operating_result || "—"}` : "belum diasesmen"} · bukti {k.evidence.accepted}/{k.evidence.total} diterima</div>)}
          {c.findings.map((f: any) => <div key={f.id}>Temuan {f.severity}: {f.title} — {f.state} ({f.actions.length} tindakan)</div>)}
        </div>)}
        {!pv.obligations.length && <p className="small muted">Pasal ini belum melahirkan kewajiban.</p>}
      </div>}
    </section>
  </div>;
}

function EvidenceTab({ ctx }: { ctx: Ctx }) {
  const [f, setF] = useState({ state: "", q: "" });
  const [applied, setApplied] = useState(f);
  const qs = new URLSearchParams(Object.entries(applied).filter(([, v]) => v)).toString();
  const [rows] = useLoad<any[]>(() => api(`/compliance/auditor/evidence?${qs}`), [qs], ctx.notify);
  const [res, setRes] = useState<Record<string, any>>({});
  const { run, busy } = useAction(ctx.notify);
  return <section className="panel">
    <div className="row"><select value={f.state} onChange={e => setF({ ...f, state: e.target.value })} aria-label="Status bukti">
      {["", "SUBMITTED", "ACCEPTED", "REJECTED"].map(s => <option key={s} value={s}>{s || "Semua status"}</option>)}</select>
      <input className="grow" value={f.q} onChange={e => setF({ ...f, q: e.target.value })} placeholder="Cari nama berkas, keterangan, kontrol" />
      <button className="btn primary" onClick={() => setApplied(f)}>Terapkan</button></div>
    {rows?.length ? <div className="tablewrap" style={{ marginTop: 12 }}><table className="data">
      <thead><tr><th>Berkas</th><th>Kontrol / tindakan</th><th>Pasal yang didukung</th><th>Peninjauan</th><th>Integritas</th></tr></thead>
      <tbody>{rows.map(e => <tr key={e.id}>
        <td><b>{e.filename}</b><div className="small muted">{e.uploaded_by} · {fmtTime(e.uploaded_at)} · {e.size_bytes ?? "?"} B</div><div className="small muted mono">{e.sha256.slice(0, 16)}…</div></td>
        <td className="small">{e.control_title || e.action_description || "—"}</td>
        <td className="small">{e.provisions || "—"}</td>
        <td><Status s={e.state} /><div className="small muted">{e.reviewed_by ? `${e.reviewed_by} · ${fmtTime(e.reviewed_at)}` : "belum ditinjau"}</div>{e.review_rationale && <div className="small">{e.review_rationale}</div>}</td>
        <td>{res[e.id] ? <span className={`badge ${res[e.id].result === "MATCH" ? "green" : "red"}`}>{res[e.id].result}</span> :
          <button className="btn sm" disabled={busy} onClick={() => run(async () => { const r = await api(`/compliance/auditor/evidence/${e.id}/verify`, { method: "POST" }); setRes(x => ({ ...x, [e.id]: r })); })}>Verifikasi hash</button>}</td>
      </tr>)}</tbody></table></div> : <Empty>Tidak ada bukti untuk saringan ini.</Empty>}
  </section>;
}

function Completeness({ ctx }: { ctx: Ctx }) {
  const [d, setD] = useState<any>(null);
  const { run, busy } = useAction(ctx.notify);
  return <section className="panel">
    <header><div><h2>Pemeriksaan kelengkapan jejak audit</h2><p>Menguji bahwa setiap keputusan penting punya persetujuan, pemisahan tugas, dan event audit.</p></div>
      <button className="btn primary" disabled={busy} onClick={() => run(async () => setD(await api("/compliance/auditor/completeness")))}>{d ? "Jalankan ulang" : "Jalankan pemeriksaan"}</button></header>
    {!d ? <Empty>Belum dijalankan. Hasil pemeriksaan juga tercatat di jejak audit.</Empty> : <>
      <p className="small">Diperiksa {fmtTime(d.checked_at)} · lulus {d.summary.PASS} · peringatan {d.summary.WARN} · gagal {d.summary.FAIL} · kelengkapan {d.completeness_percent}%</p>
      <ul className="list">{d.checks.map((c: any) => <li key={c.code}>
        <div className="between"><b className="small">{c.title}</b><span className={`badge ${STATUS_TONE[c.status]}`}>{c.status}{c.count ? ` · ${c.count}` : ""}</span></div>
        {c.count > 0 && <div className="small muted">{c.hint}
          <ul>{c.samples.map((s: any) => <li key={s.ref} className="mono">{s.ref.slice(0, 8)} — {s.label}</li>)}</ul></div>}
      </li>)}</ul></>}
  </section>;
}