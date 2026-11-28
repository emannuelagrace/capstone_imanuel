import { api } from "../api";
import type { Ctx } from "../ui";
import { Empty, PageHead, Sev, fmtDate, fmtTime, useLoad } from "../ui";

type Posture = {
  as_at: string; basis: string;
  kpis: { active_obligations: number; regulations_in_force: number; effective_percent: number; effective_count: number;
    open_findings: number; overdue_findings: number; reports_issued: number; last_report: { id: string; title: string; issued_at: string } | null };
  by_area: { area: string; obligations: number; effective: number; effective_percent: number; open_findings: number }[];
  new_regulations: { document_id: string; canonical_number: string; title_id: string; issuer: string; version_number: number; effective_date: string }[];
  severity: Record<string, number>;
  coverage: { gaps: number; partial: number; controls_without_owner: number; excluded_ai_draft: number };
  material_gaps: { obligation_id: string; summary: string; owner: string | null; canonical_number: string; number_label: string; provision_version_id: string; age_days: number }[];
  deadlines: { action_id: string; finding_id: string; description: string; due_date: string; state: string; owner: string | null; severity: string; overdue: boolean }[];
  overdue_actions: number;
  changes: { pending_review: number; over_sla: number; sla_days: number };
};
type Trend = { months: { month: string; findings_opened: number; assessments_signed: number; assessments_effective: number }[]; note: string };

const tone = (p: number) => (p >= 80 ? "ok" : p >= 50 ? "mid" : "low");

function Kpi({ label, value, unit, note, tone: t, onClick }: { label: string; value: number | string; unit?: string; note: string; tone?: string; onClick?: () => void }) {
  const body = <>
    <span className="kpi-label">{label}</span>
    <b className={`kpi-value ${t || ""}`}>{value}{unit}</b>
    <span className="kpi-note">{note}</span>
  </>;
  return onClick ? <button type="button" className="kpi" onClick={onClick}>{body}</button> : <div className="kpi">{body}</div>;
}

/** Grafik batang ganda tanpa pustaka: temuan baru vs asesmen sign-off EFFECTIVE per bulan. */
function TrendChart({ t }: { t: Trend }) {
  const max = Math.max(1, ...t.months.flatMap(m => [m.findings_opened, m.assessments_effective]));
  const W = 520, H = 160, pad = 24, slot = (W - pad * 2) / t.months.length, bw = Math.min(18, slot / 3);
  const h = (v: number) => Math.round((v / max) * (H - pad * 2));
  return <svg viewBox={`0 0 ${W} ${H + 18}`} role="img" aria-label="Tren bulanan temuan baru dan asesmen efektif" style={{ width: "100%", height: "auto" }}>
    <line x1={pad} x2={W - pad} y1={H - pad} y2={H - pad} stroke="currentColor" opacity=".25" />
    {t.months.map((m, i) => {
      const cx = pad + slot * i + slot / 2;
      return <g key={m.month}>
        <rect x={cx - bw - 1} y={H - pad - h(m.findings_opened)} width={bw} height={h(m.findings_opened)} rx="2" fill="var(--red)"><title>{`${m.month}: ${m.findings_opened} temuan baru`}</title></rect>
        <rect x={cx + 1} y={H - pad - h(m.assessments_effective)} width={bw} height={h(m.assessments_effective)} rx="2" fill="var(--green)"><title>{`${m.month}: ${m.assessments_effective} asesmen efektif`}</title></rect>
        <text x={cx} y={H - 8} fontSize="10" textAnchor="middle" fill="currentColor" opacity=".7">{m.month.slice(5)}/{m.month.slice(2, 4)}</text>
      </g>;
    })}
  </svg>;
}

export function Postur({ ctx }: { ctx: Ctx }) {
  const [p] = useLoad<Posture>(() => api("/compliance/executive/posture"), [], ctx.notify);
  const [t] = useLoad<Trend>(() => api("/compliance/executive/trend"), [], ctx.notify);
  if (!p) return <div className="panel">Memuat postur kepatuhan…</div>;
  const k = p.kpis, last = k.last_report;
  const goReport = () => ctx.go(last ? `laporan/${last.id}` : "laporan");

  return <>
    <PageHead crumbs={`Beranda · per ${fmtDate(p.as_at)}`} title="Postur kepatuhan"
      intro="Ringkasan untuk direksi. Setiap angka dapat ditelusuri sampai pasal regulasi sumbernya lewat laporan terbit." />

    <div className="kpi-grid">
      <Kpi label="Kewajiban aktif" value={k.active_obligations} note={`dari ${k.regulations_in_force} regulasi terbit`} onClick={goReport} />
      <Kpi label="Kontrol efektif" value={k.effective_percent} unit="%" tone={tone(k.effective_percent)}
        note={`${k.effective_count} kewajiban · asesmen sign-off`} onClick={goReport} />
      <Kpi label="Temuan terbuka" value={k.open_findings} tone={k.open_findings ? "low" : "ok"}
        note={`${k.overdue_findings} lewat tenggat`} onClick={goReport} />
      <Kpi label="Laporan terbit" value={k.reports_issued}
        note={last ? `terakhir: ${last.title}` : "belum ada laporan terbit"} onClick={goReport} />
    </div>

    {/* Gap material + sebaran tingkat keparahan */}
    <div className="cols">
      <section className="panel">
        <header><div><h2>Gap material</h2>
          <p>{p.coverage.gaps} kewajiban aktif belum punya kontrol{p.coverage.partial ? ` · ${p.coverage.partial} baru tercakup sebagian` : ""}. Klik pasal untuk melihat teks sumber.</p></div></header>
        {p.material_gaps.length ? <div className="tablewrap"><table className="data">
          <thead><tr><th>Kewajiban</th><th>Pasal sumber</th><th>Pemilik</th><th>Umur</th></tr></thead>
          <tbody>{p.material_gaps.map(g => <tr key={g.obligation_id}>
            <td>{g.summary}</td>
            <td><button type="button" className="cite" onClick={() => ctx.openCite(g.provision_version_id)}>{g.canonical_number} {g.number_label}</button></td>
            <td>{g.owner || <span className="badge red">Belum ada pemilik</span>}</td>
            <td>{g.age_days} hari</td>
          </tr>)}</tbody></table></div>
          : <Empty>Tidak ada gap material: semua kewajiban aktif sudah punya kontrol.</Empty>}
        {p.coverage.gaps > p.material_gaps.length && <p className="small muted" style={{ marginBottom: 0 }}>Menampilkan {p.material_gaps.length} tertua dari {p.coverage.gaps} gap.</p>}
      </section>

      <aside>
        <section className="panel">
          <h2>Temuan terbuka per tingkat</h2>
          <ul className="list">{["CRITICAL", "HIGH", "MEDIUM", "LOW"].map(s => <li key={s}>
            <div className="between"><Sev s={s} /><b>{p.severity[s] ?? 0}</b></div>
          </li>)}</ul>
          <p className="small muted" style={{ marginBottom: 0 }}>{p.overdue_actions} tindakan remediasi lewat tenggat.</p>
        </section>
        <section className="panel">
          <h2>Perubahan regulasi</h2>
          <p style={{ margin: 0 }}><b>{p.changes.pending_review}</b> menunggu tinjauan analis</p>
          <p className={`small ${p.changes.over_sla ? "" : "muted"}`} style={{ margin: "4px 0 0", color: p.changes.over_sla ? "var(--red)" : undefined }}>
            {p.changes.over_sla} melewati SLA {p.changes.sla_days} hari
          </p>
        </section>
      </aside>
    </div>

    {/* Tren */}
    <section className="panel">
      <header><div><h2>Tren 6 bulan terakhir</h2>
        <p><span style={{ color: "var(--red)" }}>■</span> temuan baru · <span style={{ color: "var(--green)" }}>■</span> asesmen sign-off efektif</p></div></header>
      {t ? (t.months.some(m => m.findings_opened || m.assessments_signed)
        ? <><TrendChart t={t} /><p className="small muted" style={{ marginBottom: 0 }}>{t.note}</p></>
        : <Empty>Belum ada aktivitas temuan atau asesmen pada 6 bulan terakhir.</Empty>)
        : <p className="muted small">Memuat tren…</p>}
    </section>

    <div className="cols">
      <section className="panel">
        <header><div><h2>Kepatuhan per area</h2><p>Dasar hitung: {p.basis}.</p></div></header>
        {p.by_area.length ? <div className="tablewrap"><table className="data">
          <thead><tr><th>Area</th><th>Kewajiban</th><th>Kontrol efektif</th><th>Temuan terbuka</th></tr></thead>
          <tbody>{p.by_area.map(a => <tr key={a.area}>
            <td>{a.area}</td>
            <td>{a.obligations}</td>
            <td><div className="bar-cell">
              <div className="bar" role="img" aria-label={`${a.effective_percent}% efektif`}><i className={tone(a.effective_percent)} style={{ width: `${a.effective_percent}%` }} /></div>
              <span>{a.effective_percent}%</span></div></td>
            <td>{a.open_findings}</td>
          </tr>)}</tbody></table></div>
          : <Empty>Belum ada kewajiban aktif yang berlabel area (taksonomi THEME).</Empty>}
      </section>

      <aside>
        <section className="panel">
          <h2>Tenggat remediasi terdekat</h2>
          {p.deadlines.length ? <ul className="list">{p.deadlines.map(d => <li key={d.action_id}>
            <div className="between"><span className="small">{d.description}</span><Sev s={d.severity} /></div>
            <div className="sub" style={d.overdue ? { color: "var(--red)", fontWeight: 600 } : undefined}>
              {fmtDate(d.due_date)}{d.overdue ? " (terlambat)" : ""} · {d.owner || "tanpa pemilik"}</div>
          </li>)}</ul> : <Empty>Tidak ada tenggat dalam 30 hari ke depan.</Empty>}
        </section>
        <section className="panel">
          <h2>Regulasi baru terbit</h2>
          {p.new_regulations.length ? <ul className="list">{p.new_regulations.map(r => <li key={`${r.document_id}-${r.version_number}`}>
            <div className="title">{r.canonical_number}</div>
            <div className="sub">{r.title_id} · v{r.version_number} · berlaku {fmtDate(r.effective_date)}</div>
          </li>)}</ul> : <Empty>Belum ada regulasi terbit.</Empty>}
          <p style={{ marginBottom: 0 }}><button className="btn ghost" onClick={goReport}>{last ? `Buka ${last.title} →` : "Buka laporan →"}</button></p>
          {last && <p className="small muted" style={{ margin: "4px 0 0" }}>Diterbitkan {fmtTime(last.issued_at)}</p>}
        </section>
      </aside>
    </div>
  </>;
}