# Morafek CareMate

An open-source Electronic Health Record system built with FHIR R4
interoperability at its core, designed for elderly patient care and
German health IT integration.

## Architecture

```
Mobile App (Expo / React Native)
    ↓  HTTPS + JWT
Flask REST API (Python)
    ↓
MongoDB Atlas  ←→  FHIR R4 shaped collections
    ↓
Cloudinary CDN  (document + image storage)
```

## FHIR R4 Resources Implemented

| Resource | Collection | Key Codings |
|---|---|---|
| Observation | ehr_vitals | LOINC 55284-4 (BP), 8480-6, 8462-4, 8867-4 |
| Encounter | ehr_visits | v3-ActCode AMB |
| Condition | ehr_conditions | ICD-10-GM (`http://fhir.de/CodeSystem/bfarm/icd-10-gm`) |
| DocumentReference | ehr_documents | LOINC 11502-2, 18748-4, 57833-6 |
| Communication | ehr_messages | FHIR sender/recipient references |
| Bundle (export) | — | `GET /api/patient/<id>/fhir-bundle` |
