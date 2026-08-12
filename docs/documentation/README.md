# Morafek CareMate — Documentation

Documentation is organized around the three user journeys the app serves, rather than by
layer (frontend/backend) or by when a piece was written. Each part is self-contained but
cross-links the others where a feature spans roles.

| Part | Covers |
|---|---|
| [1 — Patient Journey](01-patient-journey.md) | Registration/login, dashboard, vitals, medications, visits, messaging, documents, exercises, medical profile, doctor authorization & data-sharing, research consent, FHIR export, Health Connect sync, account/privacy controls, offline behaviour |
| [2 — Doctor Journey](02-doctor-journey.md) | Patient authorization model, dashboard, recording visits, ICD-10-GM AI suggest, prescribing medications, sensor alerts, assigning exercises, clinic management, admin facility reactivation |
| [3 — Research, Admin & Consent Infrastructure](03-research-admin-consent.md) | gICS/gPAS architecture, pseudonym lifecycle, first-time gICS setup (domain/policy/module/template), identified vs. research data collections, the researcher sync journey, the admin sync-issues & erasure-approval journey, what's deferred |

**Last verified:** 2026-08-12, against the actual backend routes (`backend/routes/*.py`), mobile
screens (`mobile/app/(app)/**`), and — for gICS specifics in Part 3 — live SOAP calls against the
running gICS instance, not just its admin UI or source code. Part 3 §10 in particular reflects a
same-day gICS domain reconfiguration (new policy/module/templates) and several backend fixes
that came out of testing it end-to-end, not a static snapshot.

## Tech stack, at a glance

| Layer | Technology |
|---|---|
| Mobile/Web frontend | React Native (Expo ~54, Expo Router ~6, React 19) |
| State | Zustand |
| API client | Axios |
| Offline storage | Expo SQLite (native), in-memory fallback (web), Expo SecureStore, AsyncStorage |
| Backend | Flask 3.1 (blueprint per domain), PyMongo |
| Auth | PyJWT (HS256) — 90-day mobile tokens, 24-hour web tokens |
| Database | MongoDB Atlas |
| File storage | Cloudinary |
| AI | Google Gemini (ICD-10-GM suggestions) |
| Consent/pseudonymisation | gICS + gPAS (MIRACUM stack, local Docker only — see Part 3) |
| Hosting | Vercel (web) · Render (API, free tier) |
| Standards | FHIR R4, ISiK Stage 1, de.basisprofil.r4, KBV ERP, DSGVO |

## Source material

These three documents were written and verified directly against the current codebase, drawing
on — and superseding as the primary reference — the working notes and planning documents
previously scattered across this folder. Those originals are preserved under
[`archive/`](archive/) for historical/design-rationale context (e.g. the day-by-day trace of how
the research/admin backend was built), but should not be treated as current — several describe
intermediate states that were later corrected in the same file, which is exactly the confusion
this restructuring is meant to resolve.
