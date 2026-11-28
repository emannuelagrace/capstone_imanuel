"""Tampilan Eksekutif (Direksi, hanya baca): ringkasan postur kepatuhan, gap material, tenggat, dan tren."""
from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.compliance import services
from app.compliance.services import LATEST_SIGNED, OPEN_FINDING_STATES
from app.platform.models import AppUser
from app.platform.permissions import require
from app.shared import vocabularies as V
from app.shared.database import get_db
from app.shared.schemas import ResponseWrapper

router = APIRouter(prefix="/api/v1/compliance/executive", tags=["executive"])
R = V.AppRole
EXEC_READ = require("dashboard", "R", only=[R.EXECUTIVE])


def _pct(part: int, whole: int) -> float:
    return round(100 * part / whole, 1) if whole else 0.0


@router.get("/posture", response_model=ResponseWrapper[dict])
def posture(db: Session = Depends(get_db), user: AppUser = Depends(EXEC_READ)):
    m = services.dashboard_metrics(db)

    regs_in_force = db.execute(text("""
        SELECT count(DISTINCT dv.document_id)
        FROM compliance.obligation o
        JOIN corpus.provision_version pv ON pv.id = o.primary_citation_id
        JOIN corpus.document_version dv ON dv.id = pv.document_version_id
        WHERE o.state = 'ACTIVE'""")).scalar() or 0

    last_report = db.execute(text("""
        SELECT id::text AS id, title, issued_at::text AS issued_at
        FROM compliance.compliance_report WHERE state = 'ISSUED'
        ORDER BY issued_at DESC NULLS LAST LIMIT 1""")).first()
    reports_issued = db.execute(text(
        "SELECT count(*) FROM compliance.compliance_report WHERE state IN ('ISSUED','SUPERSEDED')")).scalar() or 0

    by_area = [dict(r._mapping) for r in db.execute(text(f"""
        WITH ob AS (
          SELECT o.id AS obligation_id, tl.value AS area
          FROM compliance.obligation o
          JOIN corpus.provision_version pv ON pv.id = o.primary_citation_id
          JOIN corpus.document_version dv ON dv.id = pv.document_version_id
          JOIN corpus.taxonomy_label tl ON tl.document_id = dv.document_id
          WHERE o.state = 'ACTIVE' AND tl.dimension = 'THEME' AND tl.state <> 'REMOVED'
        )
        SELECT ob.area,
               count(DISTINCT ob.obligation_id) AS obligations,
               count(DISTINCT ob.obligation_id) FILTER (WHERE EXISTS (
                   SELECT 1 FROM compliance.obligation_control_map m
                   WHERE m.obligation_id = ob.obligation_id AND {LATEST_SIGNED} = 'EFFECTIVE')) AS effective,
               count(DISTINCT f.id) FILTER (WHERE f.state = ANY(:open)) AS open_findings
        FROM ob LEFT JOIN compliance.finding f ON f.obligation_id = ob.obligation_id
        GROUP BY ob.area ORDER BY count(DISTINCT ob.obligation_id) DESC, ob.area"""),
        {"open": list(OPEN_FINDING_STATES)}).all()]
    for a in by_area:
        a["effective_percent"] = _pct(a["effective"], a["obligations"])

    new_regs = [dict(r._mapping) for r in db.execute(text("""
        SELECT d.id::text AS document_id, d.canonical_number, d.title_id, d.issuer,
               dv.version_number, dv.effective_date::text AS effective_date
        FROM corpus.document_version dv JOIN corpus.document d ON d.id = dv.document_id
        WHERE dv.state = 'PUBLISHED'
        ORDER BY dv.effective_date DESC, d.canonical_number LIMIT 5""")).all()]

    # Gap material: kewajiban ACTIVE yang belum punya kontrol. Sertakan provision_version_id agar angka dapat
    # ditelusuri ke pasal sumbernya (PDF: "Auditor menelusuri sampai pasal asal", "Meninjau material gap").
    gap_ids = m["drill"]["gaps"]
    material_gaps = [dict(r._mapping) for r in db.execute(text("""
        SELECT o.id::text AS obligation_id, o.plain_language_summary AS summary, u.username AS owner,
               d.canonical_number, p.number_label, pv.id::text AS provision_version_id,
               (current_date - o.created_at::date) AS age_days
        FROM compliance.obligation o
        JOIN corpus.provision_version pv ON pv.id = o.primary_citation_id
        JOIN corpus.provision p ON p.id = pv.provision_id
        JOIN corpus.document_version dv ON dv.id = pv.document_version_id
        JOIN corpus.document d ON d.id = dv.document_id
        LEFT JOIN platform.app_user u ON u.id = o.owner_id
        WHERE o.id = ANY(CAST(:ids AS uuid[])) ORDER BY o.created_at LIMIT 10"""), {"ids": gap_ids}).all()]

    return ResponseWrapper(data={
        "as_at": m["as_at"],
        "kpis": {
            "active_obligations": m["active_obligations"], "regulations_in_force": int(regs_in_force),
            "effective_percent": m["compliance_score_percent"], "effective_count": m["with_effective_control"],
            "open_findings": m["open_findings"], "overdue_findings": m["overdue_findings"],
            "reports_issued": int(reports_issued),
            "last_report": dict(last_report._mapping) if last_report else None,
        },
        "basis": m["compliance_score"]["basis"],
        "by_area": by_area,
        "new_regulations": new_regs,
        # --- tambahan ---
        "severity": m["findings_by_severity"],
        "coverage": {"gaps": m["gaps"], "partial": m["partial_coverage"], "controls_without_owner": m["controls_without_owner"],
                     "excluded_ai_draft": m["excluded_ai_draft"]},
        "material_gaps": material_gaps,
        "deadlines": m["upcoming_deadlines"][:8],
        "overdue_actions": m["overdue_actions"],
        "changes": {"pending_review": m["changes_pending_review"], "over_sla": m["changes_over_sla"],
                    "sla_days": m["change_review_sla_days"]},
    })


@router.get("/trend", response_model=ResponseWrapper[dict])
def trend(months: int = 6, db: Session = Depends(get_db), user: AppUser = Depends(EXEC_READ)):
    """Tren bulanan dari data transaksi (bukan snapshot skor historis): temuan baru, asesmen sign-off, dan
    asesmen sign-off berhasil EFFECTIVE. Cukup untuk 'tren' pada MVP tanpa tabel snapshot baru."""
    n = max(2, min(int(months), 24))
    rows = db.execute(text("""
        WITH mm AS (
          SELECT generate_series(date_trunc('month', current_date) - make_interval(months => :n - 1),
                                 date_trunc('month', current_date), interval '1 month')::date AS m)
        SELECT to_char(mm.m, 'YYYY-MM') AS month,
               (SELECT count(*) FROM compliance.finding f
                 WHERE date_trunc('month', f.created_at)::date = mm.m) AS findings_opened,
               (SELECT count(*) FROM compliance.assessment a
                 WHERE a.state = 'SIGNED_OFF' AND date_trunc('month', a.signed_off_at)::date = mm.m) AS assessments_signed,
               (SELECT count(*) FROM compliance.assessment a
                 WHERE a.state = 'SIGNED_OFF' AND a.operating_result = 'EFFECTIVE'
                   AND date_trunc('month', a.signed_off_at)::date = mm.m) AS assessments_effective
        FROM mm ORDER BY mm.m"""), {"n": n}).all()
    return ResponseWrapper(data={"months": [dict(r._mapping) for r in rows],
                                 "note": "Tren aktivitas bulanan; bukan skor kepatuhan historis."})