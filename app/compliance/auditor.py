import uuid
from typing import Optional

from fastapi import APIRouter, Depends
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.compliance import services
from app.compliance.common import get_or_404, iso, now
from app.compliance.models import ComplianceReport, Evidence, Obligation
from app.platform.governance import audit
from app.platform.models import AppUser
from app.platform.permissions import require
from app.shared import vocabularies as V
from app.shared.database import get_db
from app.shared.errors import AppError
from app.shared.schemas import ResponseWrapper
from app.shared.storage import get_object

router = APIRouter(prefix="/api/v1/compliance/auditor", tags=["auditor"])
R = V.AppRole
AUD = require("audit_trail", "R", only=[R.INTERNAL_AUDITOR])
EVID = require("evidence_access", "R", only=[R.INTERNAL_AUDITOR])
OBL = require("obligation", "R", only=[R.INTERNAL_AUDITOR])
REPORT = require("report_published", "R", only=[R.INTERNAL_AUDITOR])

# (kode, judul, tingkat, SQL yang mengembalikan kolom ref+label, petunjuk)
CHECKS: list[tuple[str, str, str, str, str]] = [
    ("APPROVAL_SOD", "Persetujuan dengan checker sama dengan maker/penyunting terakhir", "CRITICAL",
     """SELECT a.id::text AS ref, a.object_type || ' ' || a.object_id::text AS label FROM platform.approval a
        WHERE a.checker_id = a.maker_id OR a.checker_id = a.last_editor_id""",
     "Pemisahan tugas dilanggar; seharusnya mustahil karena CHECK database."),
    ("APPROVAL_NO_AUDIT", "Persetujuan tanpa satu pun event jejak audit untuk objeknya", "HIGH",
     """SELECT a.id::text AS ref, a.object_type || ' ' || a.object_id::text AS label FROM platform.approval a
        WHERE NOT EXISTS (SELECT 1 FROM platform.audit_event ae WHERE ae.object_id = a.object_id)""",
     "Setiap keputusan seharusnya meninggalkan event audit pada objek yang sama."),
    ("OBLIGATION_ACTIVE_NO_APPROVAL", "Kewajiban ACTIVE tanpa persetujuan Manajer", "CRITICAL",
     """SELECT o.id::text AS ref, left(coalesce(o.plain_language_summary, o.original_text), 90) AS label
        FROM compliance.obligation o WHERE o.state = 'ACTIVE' AND NOT EXISTS (
          SELECT 1 FROM platform.approval a WHERE a.object_type = 'obligation' AND a.object_id = o.id AND a.outcome = 'APPROVED')""",
     "Kewajiban hanya boleh dipakai dalam asesmen setelah disetujui (titik kendali #3)."),
    ("OBLIGATION_LOW_CONFIDENCE_UNREVIEWED", "Kewajiban ACTIVE berkeyakinan rendah tanpa konfirmasi tinjauan", "HIGH",
     """SELECT o.id::text AS ref, left(coalesce(o.plain_language_summary, o.original_text), 90) AS label
        FROM compliance.obligation o WHERE o.state = 'ACTIVE' AND o.low_confidence AND o.low_confidence_reviewed_by IS NULL""",
     "Keluaran AI berkeyakinan rendah wajib masuk tinjauan manusia."),
    ("OBLIGATION_CITES_WITHDRAWN", "Kewajiban ACTIVE mensitasi versi peraturan yang ditarik", "HIGH",
     """SELECT o.id::text AS ref, d.canonical_number || ' v' || dv.version_number AS label
        FROM compliance.obligation o JOIN corpus.provision_version pv ON pv.id = o.primary_citation_id
        JOIN corpus.document_version dv ON dv.id = pv.document_version_id JOIN corpus.document d ON d.id = dv.document_id
        WHERE o.state = 'ACTIVE' AND dv.state = 'WITHDRAWN'""",
     "Tinjau ulang kewajiban terhadap versi yang berlaku."),
    ("OBLIGATION_NO_OWNER", "Kewajiban ACTIVE tanpa pemilik", "MEDIUM",
     """SELECT o.id::text AS ref, left(coalesce(o.plain_language_summary, o.original_text), 90) AS label
        FROM compliance.obligation o WHERE o.state = 'ACTIVE' AND o.owner_id IS NULL""",
     "Kewajiban tanpa owner jelas (risiko proses manual PDF hal. 4)."),
    ("CONTROL_NO_OWNER", "Kontrol tanpa pemilik", "MEDIUM",
     "SELECT c.id::text AS ref, c.title AS label FROM compliance.control c WHERE c.owner_id IS NULL",
     "Tetapkan Control Owner."),
    ("ASSESSMENT_SIGNOFF_NO_APPROVAL", "Asesmen SIGNED_OFF tanpa catatan persetujuan", "CRITICAL",
     """SELECT s.id::text AS ref, c.title AS label FROM compliance.assessment s JOIN compliance.control c ON c.id = s.control_id
        WHERE s.state = 'SIGNED_OFF' AND NOT EXISTS (
          SELECT 1 FROM platform.approval a WHERE a.object_type = 'assessment' AND a.object_id = s.id AND a.outcome = 'APPROVED')""",
     "Sign-off wajib maker-checker (titik kendali #4)."),
    ("ASSESSMENT_SELF_SIGNOFF", "Asesmen disahkan oleh orang yang sama dengan penilainya", "CRITICAL",
     """SELECT s.id::text AS ref, c.title AS label FROM compliance.assessment s JOIN compliance.control c ON c.id = s.control_id
        WHERE s.state = 'SIGNED_OFF' AND s.assessed_by IS NOT NULL AND s.assessed_by = s.signed_off_by""",
     "Pemisahan tugas dilanggar."),
    ("EVIDENCE_ACCEPTED_NO_REVIEW", "Bukti ACCEPTED tanpa peninjau atau rasional", "HIGH",
     """SELECT e.id::text AS ref, e.filename AS label FROM compliance.evidence e
        WHERE e.state = 'ACCEPTED' AND (e.reviewed_by IS NULL OR e.review_rationale IS NULL OR btrim(e.review_rationale) = '')""",
     "Penerimaan bukti wajib berrasional (FR-EVR-003)."),
    ("EVIDENCE_SELF_REVIEW", "Bukti ditinjau oleh pengunggahnya sendiri", "HIGH",
     """SELECT e.id::text AS ref, e.filename AS label FROM compliance.evidence e
        WHERE e.reviewed_by IS NOT NULL AND e.reviewed_by = e.uploaded_by""",
     "Pemisahan tugas dilanggar."),
    ("EVIDENCE_NO_AUDIT", "Bukti tanpa event pengajuan di jejak audit", "MEDIUM",
     """SELECT e.id::text AS ref, e.filename AS label FROM compliance.evidence e WHERE NOT EXISTS (
          SELECT 1 FROM platform.audit_event ae WHERE ae.object_type = 'evidence' AND ae.object_id = e.id)""",
     "Setiap unggahan bukti semestinya tercatat (EVIDENCE_SUBMITTED)."),
    ("REPORT_NO_APPROVAL", "Laporan terbit tanpa persetujuan", "CRITICAL",
     """SELECT r.id::text AS ref, r.title AS label FROM compliance.compliance_report r
        WHERE r.state IN ('ISSUED','SUPERSEDED','WITHDRAWN') AND NOT EXISTS (
          SELECT 1 FROM platform.approval a WHERE a.object_type = 'compliance_report' AND a.object_id = r.id AND a.outcome = 'APPROVED')""",
     "Penerbitan laporan wajib persetujuan Manajer (titik kendali #6)."),
    ("REPORT_SELF_ISSUE", "Laporan diterbitkan oleh pembangkitnya sendiri", "CRITICAL",
     """SELECT r.id::text AS ref, r.title AS label FROM compliance.compliance_report r
        WHERE r.issued_by IS NOT NULL AND r.issued_by = r.generated_by""",
     "Pemisahan tugas dilanggar."),
    ("FINDING_CLOSED_NO_APPROVAL", "Temuan CLOSED/RISK_ACCEPTED tanpa persetujuan", "CRITICAL",
     """SELECT f.id::text AS ref, f.title AS label FROM compliance.finding f
        WHERE f.state IN ('CLOSED','RISK_ACCEPTED') AND NOT EXISTS (
          SELECT 1 FROM platform.approval a WHERE a.object_type = 'finding' AND a.object_id = f.id AND a.outcome = 'APPROVED')""",
     "Temuan hanya boleh ditutup lewat verifikasi dan persetujuan (PDF hal. 16)."),
    ("FINDING_SELF_CLOSURE", "Penutupan temuan oleh pengusul penutupan yang sama", "CRITICAL",
     """SELECT f.id::text AS ref, f.title AS label FROM compliance.finding f
        WHERE f.closed_by IS NOT NULL AND f.closed_by = f.closure_submitted_by""",
     "Pemisahan tugas dilanggar."),
    ("AUDIT_SEQUENCE_GAPS", "Celah pada urutan id jejak audit (indikatif)", "LOW",
     """SELECT (a.id + 1)::text AS ref, 'celah setelah id ' || a.id AS label FROM platform.audit_event a
        WHERE a.id < (SELECT max(id) FROM platform.audit_event)
          AND NOT EXISTS (SELECT 1 FROM platform.audit_event b WHERE b.id = a.id + 1)""",
     "Celah dapat berasal dari transaksi yang dibatalkan; tinjau bila jumlahnya besar atau berkelompok."),
]


def _status(count: int, severity: str) -> str:
    if count == 0:
        return "PASS"
    return "FAIL" if severity in ("CRITICAL", "HIGH") else "WARN"


def run_completeness(db: Session) -> list[dict]:
    out = []
    for code, title, severity, sql, hint in CHECKS:
        count = db.execute(text(f"SELECT count(*) FROM ({sql}) q")).scalar() or 0
        samples = [dict(r._mapping) for r in db.execute(text(f"SELECT * FROM ({sql}) q LIMIT 10")).all()] if count else []
        out.append({"code": code, "title": title, "severity": severity, "count": int(count),
                    "status": _status(int(count), severity), "samples": samples, "hint": hint})
    try:
        services.verify_report_traceability(db)
        out.append({"code": "TRACEABILITY", "title": "Setiap kewajiban memiliki sitasi valid ke versi terbit", "severity": "CRITICAL",
                    "count": 0, "status": "PASS", "samples": [], "hint": ""})
    except AppError as e:
        out.append({"code": "TRACEABILITY", "title": "Setiap kewajiban memiliki sitasi valid ke versi terbit", "severity": "CRITICAL",
                    "count": 1, "status": "FAIL", "samples": [{"ref": e.code, "label": e.message}],
                    "hint": "Perbaiki sitasi sebelum laporan dapat diterbitkan."})
    return out


@router.get("/completeness", response_model=ResponseWrapper[dict])
def completeness(db: Session = Depends(get_db), user: AppUser = Depends(AUD)):
    checks = run_completeness(db)
    summary = {s: sum(c["status"] == s for c in checks) for s in ("PASS", "WARN", "FAIL")}
    audit(db, user.id, "AUDIT_COMPLETENESS_CHECKED", "audit_event", None, after=summary, correlation_id=uuid.uuid4())
    db.commit()
    return ResponseWrapper(data={"checked_at": now().isoformat(), "summary": summary, "checks": checks,
                                 "completeness_percent": round(100 * summary["PASS"] / len(checks), 1) if checks else 0.0})


@router.get("/overview", response_model=ResponseWrapper[dict])
def overview(db: Session = Depends(get_db), _: AppUser = Depends(AUD)):
    q = lambda sql: db.execute(text(sql)).scalar() or 0  # noqa: E731
    ev_states = dict(db.execute(text("SELECT state, count(*) FROM compliance.evidence GROUP BY state")).all())
    return ResponseWrapper(data={
        "audit_events": int(q("SELECT count(*) FROM platform.audit_event")),
        "audit_events_30d": int(q("SELECT count(*) FROM platform.audit_event WHERE occurred_at >= now() - interval '30 days'")),
        "approvals": int(q("SELECT count(*) FROM platform.approval")),
        "evidence_by_state": {k: int(v) for k, v in ev_states.items()},
        "obligations_active": int(q("SELECT count(*) FROM compliance.obligation WHERE state = 'ACTIVE'")),
        "reports_issued": int(q("SELECT count(*) FROM compliance.compliance_report WHERE state IN ('ISSUED','SUPERSEDED')")),
        "ai_calls": int(q("SELECT count(*) FROM platform.ai_call_log")),
        "ai_calls_low_grounding": int(q("SELECT count(*) FROM platform.ai_call_log WHERE NOT grounding_passed OR NOT schema_valid")),
        "last_audit_event_at": q("SELECT max(occurred_at)::text FROM platform.audit_event") or None})


@router.get("/evidence", response_model=ResponseWrapper[list])
def list_evidence(state: Optional[str] = None, q: Optional[str] = None, control_id: Optional[str] = None,
                  limit: int = 200, db: Session = Depends(get_db), _: AppUser = Depends(EVID)):
    where, params = ["TRUE"], {"lim": max(1, min(limit, 500))}
    if state:
        where.append("e.state = :state")
        params["state"] = state
    if control_id:
        where.append("e.control_id = CAST(:cid AS uuid)")
        params["cid"] = control_id
    if q:
        where.append("(e.filename ILIKE :q OR e.description ILIKE :q OR c.title ILIKE :q)")
        params["q"] = f"%{q}%"
    rows = db.execute(text(f"""
        SELECT e.id::text AS id, e.filename, e.description, e.state, e.sha256, e.size_bytes,
               e.uploaded_at::text AS uploaded_at, up.username AS uploaded_by,
               e.reviewed_at::text AS reviewed_at, rv.username AS reviewed_by, e.review_rationale,
               e.control_id::text AS control_id, c.title AS control_title,
               e.remediation_action_id::text AS action_id, ra.description AS action_description, ra.finding_id::text AS finding_id,
               (SELECT string_agg(DISTINCT d.canonical_number || ' ' || p.number_label, '; ')
                  FROM compliance.obligation_control_map m
                  JOIN compliance.obligation o ON o.id = m.obligation_id
                  JOIN corpus.provision_version pv ON pv.id = o.primary_citation_id
                  JOIN corpus.provision p ON p.id = pv.provision_id
                  JOIN corpus.document_version dv ON dv.id = pv.document_version_id
                  JOIN corpus.document d ON d.id = dv.document_id
                 WHERE m.control_id = e.control_id) AS provisions
        FROM compliance.evidence e
        LEFT JOIN compliance.control c ON c.id = e.control_id
        LEFT JOIN compliance.remediation_action ra ON ra.id = e.remediation_action_id
        LEFT JOIN platform.app_user up ON up.id = e.uploaded_by
        LEFT JOIN platform.app_user rv ON rv.id = e.reviewed_by
        WHERE {' AND '.join(where)} ORDER BY e.uploaded_at DESC LIMIT :lim"""), params).all()
    return ResponseWrapper(data=[dict(r._mapping) for r in rows])


@router.post("/evidence/{eid}/verify", response_model=ResponseWrapper[dict])
def verify_evidence(eid: str, db: Session = Depends(get_db), user: AppUser = Depends(EVID)):
    """Hitung ulang SHA-256 berkas tersimpan dan bandingkan dengan hash saat unggah."""
    ev = get_or_404(db, Evidence, eid)
    data = get_object(ev.object_key)
    if data is None:
        result, actual = "MISSING", None
    else:
        actual = services.sha256_hex(data)
        result = "MATCH" if actual == ev.sha256 else "MISMATCH"
    audit(db, user.id, "EVIDENCE_INTEGRITY_VERIFIED", "evidence", ev.id, after={"result": result, "stored_sha256": ev.sha256})
    db.commit()
    return ResponseWrapper(data={"id": str(ev.id), "filename": ev.filename, "result": result, "stored_sha256": ev.sha256,
                                 "actual_sha256": actual, "verified_at": now().isoformat()})


def _chain_status(chain: dict) -> str:
    controls = chain.get("controls") or []
    if not controls:
        return "NO_CONTROL"
    if all((c.get("latest_assessment") or {}).get("operating_result") == "EFFECTIVE"
           and (c.get("latest_assessment") or {}).get("state") == "SIGNED_OFF" for c in controls):
        return "EFFECTIVE"
    return "PARTIAL"


@router.get("/trace/provision/{pv_id}", response_model=ResponseWrapper[dict])
def trace_from_provision(pv_id: str, db: Session = Depends(get_db), user: AppUser = Depends(OBL)):
    """Arah maju: pasal -> kewajiban -> persetujuan -> kontrol -> asesmen -> bukti -> temuan."""
    from app.compliance.reporting import trace as chain_for
    from app.corpus.services import resolve_citations

    res = resolve_citations(db, [pv_id])
    if res.unresolved:
        raise AppError(404, "NOT_FOUND", "Pasal/versi tidak ditemukan")
    obligations = db.scalars(select(Obligation).where(Obligation.primary_citation_id == pv_id)
                             .order_by(Obligation.created_at)).all()
    chains = []
    for ob in obligations:
        chain = chain_for(str(ob.id), db, user).data
        chain["status"] = _chain_status(chain)
        chains.append(chain)
    overall = ("NO_OBLIGATION" if not chains else "NO_CONTROL" if any(c["status"] == "NO_CONTROL" for c in chains)
               else "EFFECTIVE" if all(c["status"] == "EFFECTIVE" for c in chains) else "PARTIAL")
    return ResponseWrapper(data={"direction": "PROVISION_TO_STATUS", "citation": res.resolved[0].model_dump(),
                                 "status": overall, "obligations": chains})


@router.get("/trace/report/{rid}", response_model=ResponseWrapper[dict])
def trace_from_report(rid: str, db: Session = Depends(get_db), user: AppUser = Depends(REPORT)):
    """Arah mundur: butir laporan -> sitasi -> versi dokumen terbit; menandai butir yang tidak lagi terresolusi."""
    rep = get_or_404(db, ComplianceReport, rid)
    payload = rep.payload or {}
    inventory = payload.get("obligation_inventory") or []
    if not inventory:
        raise AppError(422, "LEGACY_REPORT", "Laporan versi lama tidak menyimpan inventaris kewajiban yang dapat ditelusuri")
    pv_ids = [i["citation"]["provision_version_id"] for i in inventory if i.get("citation")]
    found = {r.pv_id: dict(r._mapping) for r in db.execute(text("""
        SELECT pv.id::text AS pv_id, p.number_label, d.canonical_number, dv.version_number, dv.state AS version_state,
               dv.effective_date::text AS effective_date, d.status AS document_status, (pv.text IS NOT NULL) AS has_text
        FROM corpus.provision_version pv JOIN corpus.provision p ON p.id = pv.provision_id
        JOIN corpus.document_version dv ON dv.id = pv.document_version_id JOIN corpus.document d ON d.id = dv.document_id
        WHERE pv.id = ANY(CAST(:ids AS uuid[]))"""), {"ids": pv_ids}).all()}
    items, unresolved = [], 0
    for i in inventory:
        pv = (i.get("citation") or {}).get("provision_version_id")
        hit = found.get(pv)
        ok = hit is not None and hit["version_state"] != "WITHDRAWN"
        unresolved += 0 if ok else 1
        items.append({"obligation_id": i["obligation_id"], "summary": i.get("summary"), "coverage": i.get("coverage"),
                      "owner": i.get("owner"), "provision_version_id": pv, "resolved": ok,
                      "canonical_number": hit["canonical_number"] if hit else (i.get("citation") or {}).get("canonical_number"),
                      "number_label": hit["number_label"] if hit else (i.get("citation") or {}).get("number_label"),
                      "version_number": hit["version_number"] if hit else None,
                      "version_state": hit["version_state"] if hit else "NOT_FOUND",
                      "effective_date": hit["effective_date"] if hit else None})
    return ResponseWrapper(data={"direction": "REPORT_TO_PROVISION",
                                 "report": {"id": str(rep.id), "title": rep.title, "state": rep.state, "issued_at": iso(rep.issued_at)},
                                 "total": len(items), "unresolved": unresolved, "items": items,
                                 "traceability_flag": bool(payload.get("traceability_verified"))})


@router.get("/reports", response_model=ResponseWrapper[list])
def reports_for_audit(db: Session = Depends(get_db), _: AppUser = Depends(REPORT)):
    return ResponseWrapper(data=[{"id": str(r.id), "title": r.title, "state": r.state, "issued_at": iso(r.issued_at)}
                                 for r in db.scalars(select(ComplianceReport)
                                                     .where(ComplianceReport.state.in_(("ISSUED", "SUPERSEDED", "WITHDRAWN")))
                                                     .order_by(ComplianceReport.created_at.desc()))])