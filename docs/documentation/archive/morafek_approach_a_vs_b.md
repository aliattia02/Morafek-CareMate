# Morafek CareMate — Architecture Comparison
## Approach A (Cloud-Hybrid) vs. Approach B (Full On-Premise)

**Project:** Morafek CareMate · React Native (Expo SDK 53) · Flask/Python · FHIR R4  
**Compliance scope:** DSGVO · KHZG · ISiK Stage 1 · de.basisprofil.r4  
**Last updated:** May 2026

---

## Architecture Overview

### Approach A — Cloud-Hybrid

```
Mobile app (SQLite · local-first)
    ├── P2P path          → Doctor app (no internet)
    ├── Manual export     → Orbis HIS (hospital intranet)  ──(manual)──► Flask
    └── Internet          → Flask backend (cloud)
                                ├── gICS (cloud-hosted TTP)
                                ├── gPAS (cloud-hosted TTP)
                                └── MongoDB Atlas (cloud sync target)
```

- Mobile apps communicate with a **shared cloud Flask backend**
- gICS/gPAS run on cloud or a separate TTP server
- Orbis HIS integration is indirect (manual export → cloud)
- P2P offline path remains available
- One backend instance serves all hospitals

### Approach B — Full On-Premise

```
Mobile app (SQLite · local-first)
    ├── P2P path          → Doctor app (no internet)
    └── Hospital VPN/WiFi → Flask backend (on-premise · hospital VM)
                                ├── gICS (hospital-hosted · MIRACUM)
                                ├── gPAS (hospital-hosted · MIRACUM)
                                └── Orbis FHIR API (OFI · R4 endpoint)
                                        └── Orbis DB (Oracle / MSSQL)
```

> All components within hospital network boundary. No external cloud path.

- Mobile apps communicate with the hospital's own Flask instance via VPN/WiFi
- gICS/gPAS run on the hospital server (MIRACUM stack)
- Writes appear in Orbis DB immediately via the OFI FHIR endpoint
- P2P offline path remains available
- Each hospital requires its own deployment

---

## Comparison Matrix

### 1. Data Sovereignty & Compliance (DSGVO, KHZG)

| Factor | Approach A | Approach B |
|---|---|---|
| PHI location | Leaves hospital network (MongoDB Atlas) | Stays inside hospital network at all times |
| DSGVO Art. 28 | Processor agreement required with cloud provider | Not required (no external processors) |
| Schrems II exposure | Yes — US-based cloud provider risk | None |
| KHZG alignment | Requires additional contractual safeguards | Natively compliant |
| DSB (Datenschutzbeauftragter) approval | 12–18 month approval process typical | Faster approval path; data never leaves hospital |
| PHI duplication | PHI stored in both Orbis and MongoDB Atlas | Single authoritative store (Orbis DB) |
| Pseudonym/gPAS | Cloud-hosted TTP; Art. 9 consent via gICS | Hospital-hosted TTP (MIRACUM); same gICS/gPAS stack |

**Verdict:** Approach B is natively DSGVO/KHZG-compliant. Approach A requires explicit Art. 28 agreements and faces Schrems II legal exposure.

---

### 2. Infrastructure Complexity

| Factor | Approach A | Approach B |
|---|---|---|
| Backend instances | One shared cloud instance | One per hospital (VM, container, or bare metal) |
| Database | MongoDB Atlas (managed cloud) | Orbis DB (Oracle/MSSQL) — existing hospital infra |
| TTP stack | Cloud-hosted gICS + gPAS | Hospital-hosted gICS + gPAS (MIRACUM) |
| Network topology | Public internet + optional hospital VPN | Hospital LAN/VPN only |
| Docker stack | Flask + MongoDB + gICS + gPAS containers | Flask + gICS + gPAS containers (no Atlas) |
| Dependency count | Higher (cloud provider + TTP provider + DB) | Lower (all within hospital IT perimeter) |

**Verdict:** Approach A has simpler central ops but introduces external dependencies. Approach B has higher per-hospital footprint but no external service dependencies.

---

### 3. Deployment & Operations

| Factor | Approach A | Approach B |
|---|---|---|
| Initial deployment | Single deployment to cloud provider | Deployment coordination with hospital IT per site |
| Updates/releases | Push to cloud → all hospitals updated | Rolling deployment per hospital instance |
| Configuration | Centrally managed `config.py` / env vars | Per-hospital config (DB credentials, OFI endpoints, VPN) |
| IT ticket dependency | None (developer-controlled) | Required — hospital IT must provision VM, firewall rules, VPN |
| Monitoring | Cloud-native (e.g. Render, AWS CloudWatch) | Per-instance monitoring; must integrate with hospital SIEM |
| On-call responsibility | Developer/vendor team | Shared with hospital IT |
| CI/CD pipeline | Straightforward (one target) | Requires per-hospital pipeline or on-premise CI runners |

**Verdict:** Approach A has lower operational overhead for the development team. Approach B requires deeper hospital IT engagement but places operations responsibility closer to the data owner.

---

### 4. Offline Capabilities

Both approaches share the same offline layer — this dimension is **architecture-neutral**.

| Capability | Both Approaches |
|---|---|
| Local storage | SQLite via `expo-sqlite` (Android/iOS); in-memory fallback (Web) |
| Queued vitals | `pending_vitals` table; auto-sync on reconnect |
| Queued medication intakes | `pending_medication_intakes`; auto-sync on reconnect |
| Cached medication schedule | `today_medications_cache`; shown with ⚠ stale banner |
| P2P doctor path | Available in both; no internet required |
| Retry logic | Exponential back-off: 2 s → 4 s → 8 s → 15 s cap (4 retries) |

**Difference:** In Approach B, "going offline" from the hospital VPN/WiFi equals losing backend access entirely (no cloud fallback). In Approach A, patients outside the hospital can still reach the cloud backend. This makes **Approach A more resilient for outpatient/remote use cases**.

---

### 5. Scalability

| Factor | Approach A | Approach B |
|---|---|---|
| Horizontal scaling | Straightforward (cloud autoscaling) | Per-hospital vertical scaling; limited by hospital VM budget |
| Patient volume | Single DB scales with Atlas tier upgrades | Bounded by Orbis DB capacity (Oracle/MSSQL licensing) |
| Concurrent hospitals | Zero additional infra per new hospital | New VM + deployment + IT approval per hospital |
| Traffic spikes | Handled by cloud provider | Must be pre-provisioned by hospital IT |
| Schema evolution | MongoDB schema-flexible | OFI FHIR API schema constraints; Orbis version-dependent |

**Verdict:** Approach A scales horizontally with minimal effort. Approach B scales vertically per site and is bounded by hospital procurement cycles.

---

### 6. Multi-Hospital Scenarios

| Factor | Approach A | Approach B |
|---|---|---|
| Cross-hospital patient lookup | Yes — single MongoDB Atlas store | No — data siloed per hospital instance |
| Shared patient record | Possible (same `patient_id` across hospitals) | Requires pseudonym federation proxy (Stage 2 roadmap) |
| Doctor access across sites | Yes (shared auth, `authorized_doctors` array) | Requires inter-hospital auth bridge |
| Consent portability | Single gICS instance holds all consents | Consent siloed per hospital gICS |
| Referral workflows | Supported natively | Requires manual data exchange or OFI FHIR export |

**Verdict:** Approach A is significantly stronger for multi-hospital scenarios. Approach B requires a **pseudonym federation proxy** (planned Stage 2) to achieve any cross-site interoperability without sharing PHI.

---

### 7. Research & MIRACUM Integration

| Factor | Approach A | Approach B |
|---|---|---|
| MIRACUM pipeline readiness | Requires ETL bridge from MongoDB Atlas to MIRACUM FHIR store | Native — gICS/gPAS already on MIRACUM stack; Orbis is MIRACUM source system |
| FHIR export quality | FHIR R4 bundles generated from MongoDB; ICD codes optional (gaps possible) | Orbis FHIR API (OFI) is the authoritative clinical record |
| Pseudonymisation | gPAS on cloud TTP; pseudonym suffix only sent to client | gPAS on hospital TTP; MIRACUM-standard pseudonym lifecycle |
| Data completeness | Only data entered via CareMate; Orbis data not automatically synced | Full Orbis patient record available via OFI |
| Consent audit trail | gICS cloud instance | gICS hospital instance — directly auditable by hospital DPO |
| Research store (Stage 3) | MongoDB Atlas can serve as research-only store | MongoDB or HAPI FHIR fed from Orbis via MIRACUM pipeline |

**Verdict:** Approach B is the natural fit for MIRACUM-aligned research. Approach A requires an additional ETL layer and cloud-to-MIRACUM bridging.

---

### 8. Cost

| Cost Factor | Approach A | Approach B |
|---|---|---|
| Cloud hosting | Ongoing (Flask server + MongoDB Atlas tier) | None (runs on hospital VM) |
| TTP hosting | Cloud gICS/gPAS service costs | Covered by hospital MIRACUM license |
| Database licensing | MongoDB Atlas (flexible, pay-per-use) | Oracle/MSSQL already licensed by hospital |
| Per-hospital deployment cost | ~Zero (shared infra) | IT staff time per site + VM provisioning |
| Scaling cost | Linear with Atlas/cloud tier | Hospital procurement cycle (CapEx) |
| Estimated ongoing (small scale) | €200–600/month (cloud) | €0 recurring (absorbed into hospital IT budget) |
| Audit & compliance cost | Higher (external auditor, cloud DPA, Schrems II counsel) | Lower (in-scope for existing hospital ISMS) |

**Verdict:** Approach A has higher recurring operational costs but lower per-hospital onboarding cost. Approach B shifts costs to hospital IT (already budgeted) and eliminates cloud fees.

---

### 9. Development Complexity

| Factor | Approach A | Approach B |
|---|---|---|
| Backend target | Single consistent environment | Must test against Orbis OFI (version-dependent) |
| OFI write support | Not required | Required — write support varies by Orbis version |
| MongoDB ↔ Orbis FHIR mapping | Not required | Required — full FHIR R4 resource mapping to OFI |
| Local dev setup | `docker-compose up` (Flask + Atlas + gICS + gPAS) | Same + OFI mock or Orbis test instance |
| `GPAS_ENABLED=false` mode | Supported (fallback to `_id`) | Same |
| Staging environment | Cloud staging instance | Requires hospital to provide staging Orbis instance |
| Schema migrations | MongoDB schema-flexible; no migrations | Orbis schema is fixed; app must adapt to OFI contract |
| FHIR resource conformance | de.basisprofil.r4, ISiK Stage 1 | Same, plus OFI-specific resource constraints |
| ICD-10 AI suggest (`/api/ehr/icd10-suggest`) | Works identically in both | Works identically in both |

**Verdict:** Approach A is easier to develop and test in isolation. Approach B introduces the OFI integration layer as a significant additional complexity, especially around write operations and version compatibility.

---

### 10. Risk Profile

| Risk | Approach A | Approach B |
|---|---|---|
| **Regulatory** | HIGH — Schrems II, Art. 28 DPA, DSB approval delay | LOW — data never leaves hospital |
| **Vendor lock-in** | MEDIUM — MongoDB Atlas, cloud provider | MEDIUM — Orbis/Dedalus OFI version dependency |
| **Availability** | MEDIUM — cloud provider SLA (99.9%+) | MEDIUM — hospital IT SLA (often lower) |
| **Data breach surface** | HIGHER — public internet + cloud storage | LOWER — hospital perimeter only |
| **OFI write compatibility** | Not applicable | MEDIUM-HIGH — OFI write support varies by Orbis version |
| **IT dependency** | LOW (developer-controlled) | HIGH — blocked by hospital IT approval/procurement |
| **Business continuity** | MEDIUM — cloud outage affects all hospitals | LOW (per-hospital) — one hospital down ≠ others affected |
| **P2P path failure** | Same in both approaches | Same in both approaches |

**Verdict:** Approach B has a lower regulatory and data breach risk. Approach A has lower operational/IT dependency risk.

---

### 11. TI (Telematikinfrastruktur) Integration

| Factor | Approach A | Approach B |
|---|---|---|
| TI connector location | Must be cloud-accessible or bridged via hospital VPN | Same LAN as Flask backend — direct access |
| ePA (elektronische Patientenakte) | Requires TI gateway bridge from cloud | Natural integration via hospital TI gateway |
| KBV ERP (e-prescribing) | Requires TI connector accessible from cloud | TI connector on hospital LAN; Flask calls it directly |
| LANR / GKV-KVID validation | Via TI or manual; cloud latency applies | Via TI on same network; lower latency |
| Telematik-ID | Must be federated from hospital to cloud | Stored and resolved within hospital network |
| Connectivity complexity | High — cloud ↔ TI bridge needed | Low — Flask and TI connector co-located |

**Verdict:** Approach B is significantly simpler for TI integration. Approach A requires a secure bridge between the public cloud and the hospital's TI connector, which is architecturally complex and introduces additional compliance surface.

---

### 12. Disaster Recovery

| Factor | Approach A | Approach B |
|---|---|---|
| Backup responsibility | Cloud provider (MongoDB Atlas automated backups) | Hospital IT (Orbis DB backup procedures) |
| RTO (Recovery Time Objective) | Minutes (cloud provider managed failover) | Hours–days (hospital IT procedures) |
| RPO (Recovery Point Objective) | Minutes (continuous Atlas backup) | Depends on hospital backup schedule (daily typical) |
| Multi-region redundancy | Available (Atlas multi-region) | Requires hospital to provision secondary site |
| Flask backend failover | Cloud autoscaling / container restart | Manual or scripted restart by hospital IT |
| Offline resilience during outage | SQLite cache continues to serve read data | Same SQLite cache; no cloud fallback |
| Data loss risk | Low (Atlas PITR) | Medium (depends on hospital DRP maturity) |
| DR testing | Developer team controls schedule | Must coordinate with hospital IT for DR drills |

**Verdict:** Approach A has superior built-in disaster recovery via managed cloud infrastructure. Approach B's DR quality is entirely dependent on the hospital's existing DRP maturity.

---

## Summary Scorecard

| Dimension | Approach A (Cloud-Hybrid) | Approach B (On-Premise) |
|---|:---:|:---:|
| Data Sovereignty & DSGVO | ⚠ Requires DPA | ✅ Native |
| Infrastructure Complexity | ✅ Simpler centrally | ⚠ Per-hospital |
| Deployment & Operations | ✅ Developer-controlled | ⚠ IT-dependent |
| Offline Capabilities | ✅ Better (remote access) | ⚠ VPN-dependent |
| Scalability | ✅ Cloud autoscaling | ⚠ CapEx-bound |
| Multi-Hospital Scenarios | ✅ Native | ⚠ Needs federation |
| Research / MIRACUM | ⚠ Needs ETL bridge | ✅ Native |
| Cost (recurring) | ⚠ Cloud fees | ✅ Absorbed by hospital |
| Development Complexity | ✅ Simpler | ⚠ OFI layer |
| Risk Profile | ⚠ Regulatory exposure | ✅ Lower breach surface |
| TI Integration | ⚠ Bridge required | ✅ Co-located |
| Disaster Recovery | ✅ Managed (Atlas PITR) | ⚠ Hospital-dependent |
| **Overall** | **Better for rapid scale** | **Better for compliance** |

---

## Recommended Rollout Path

### Stage 1 — Pilot (Approach B)
Deploy Approach B at a single pilot hospital.  
- Clean DSGVO/KHZG compliance from day one  
- No MongoDB Atlas needed  
- Native Orbis HIS integration via OFI  
- Reuses hospital's existing MIRACUM gICS/gPAS stack  

### Stage 2 — Network
Expand Approach B to additional hospitals.  
- Add a **pseudonym federation proxy** between hospital instances  
- Cross-site interoperability without exchanging raw PHI  
- Each hospital retains data sovereignty  

### Stage 3 — Research
Introduce a research-only data store.  
- MongoDB Atlas or HAPI FHIR server, fed from Orbis via MIRACUM pipeline  
- Pseudonymised export only; no direct PHI in research store  
- Enables cross-hospital cohort queries under consent  
- Brings back Approach A's scalability advantages without the compliance risk  

---

## Key Technical Notes

### gPAS Pseudonym Lifecycle (both approaches)

| Event | Action |
|---|---|
| Patient registration | `get_or_create()` — fire-and-forget |
| Consent grant (strict flow) | `get_or_create_pseudonym()` — hard failure; gICS rolled back on gPAS failure |
| Consent revoke | Pseudonym **retained** in gPAS + MongoDB/Orbis |
| Account deletion | Local cache deleted; gPAS record **retained** (Treuhandstelle compliance) |
| Admin reactivation | Old pseudonym deleted; new pseudonym created |

> The full gPAS pseudonym is **never sent to the mobile client**. Only the last 4 characters (`pseudonymSuffix`) are transmitted.

### GPAS_ENABLED=false Mode
When `GPAS_ENABLED=false` is set (e.g. local dev), gPAS calls are skipped. Consent is still recorded in gICS and the primary DB; the pseudonym field is left `null`. Export falls back to MongoDB `_id` / Orbis resource ID as the FHIR Patient ID.

### OFI Write Compatibility (Approach B only)
Orbis FHIR Interface (OFI) write support varies by hospital Orbis version. Before deployment, confirm:
- OFI version installed at target hospital
- Which FHIR R4 resource types support `PUT`/`POST` (Encounter, MedicationRequest, Observation, Condition)
- Whether OFI is in read-only or read-write mode

### Consent Dual-Flow
- **Soft flow** (`POST /api/patient/consent`): gICS/gPAS failures are fire-and-forget. MongoDB/Orbis always written.
- **Strict flow** (`POST /api/consent/accept`): gICS/gPAS failures are hard (502). Primary DB written **only after** both TTP services succeed. Used by the mobile app consent screen.

---

*This document is derived from the Morafek CareMate User Journey Documentation (May 2026) and the Approach A vs B architecture diagram.*
