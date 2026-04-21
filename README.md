<div align="center">

# 🏥 Morafek CareMate

> **"Morafek"** (مُرَافِق) means *companion* in Arabic — your personal health companion.

Morafek CareMate is a **Personal Health Record (PHR)** app that connects patients and doctors in one unified platform. Patients track their health, manage medical documents, and communicate with their care team. Doctors record visits, assign exercise plans, and monitor patient health — all FHIR R4 compliant and built for the German healthcare system.

[![FHIR R4](https://img.shields.io/badge/FHIR-R4-blue?style=flat-square)](https://hl7.org/fhir/R4/)
[![ISiK Stage 1](https://img.shields.io/badge/ISiK-Stage%201-green?style=flat-square)](https://simplifier.net/isik)
[![DSGVO Compliant](https://img.shields.io/badge/DSGVO-Compliant-orange?style=flat-square)]()
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-iOS%20%7C%20Android%20%7C%20Web-lightgrey?style=flat-square)]()
[![PRs Welcome](https://img.shields.io/badge/PRs-Welcome-brightgreen?style=flat-square)](CONTRIBUTING.md)

### 🌐 [Try it live → morafek-care-mate.vercel.app](https://morafek-care-mate.vercel.app/)

</div>

---

## 📋 Table of Contents

1. [Overview](#-overview)
2. [Demo](#-try-it-now)
3. [Screenshots](#-screenshots)
4. [Features](#-features)
5. [Tech Stack](#️-tech-stack)
6. [Getting Started](#-getting-started)
7. [Feature Status](#-feature-status)
8. [Contributing](#-contributing)
9. [License](#-license)

---

## 🩺 Overview

Healthcare data is scattered across clinics, paper records, and spreadsheets. **Morafek CareMate** brings it all together — vitals, visits, documents, and exercises — in one secure, standards-compliant place.

| | |
|---|---|
| **For patients** | Log vitals, upload documents, view visit history, and message your doctor |
| **For doctors** | Manage patients, record visits with AI-assisted diagnosis coding, and assign exercise plans |
| **Standards** | FHIR R4 · ISiK Stage 1 · ICD-10-GM · LOINC |
| **Languages** | Arabic / English |

---

## 🧪 Try It Now

The app is live at **[morafek-care-mate.vercel.app](https://morafek-care-mate.vercel.app/)** — no sign-up needed to explore.

Use the demo accounts below, or tap the **"Demo Account"** banner on the login screen to auto-fill the credentials instantly.

| Role | Username | Password |
|---|---|---|
| 🧑 Patient | `test1` | `4444` |
| 👨‍⚕️ Doctor | `testd1` | `4444` |

> **Note:** The backend runs on a free Render instance and may take ~30 seconds to wake up on first load. A progress banner will appear while it starts.

---

## 📱 Screenshots

### Patient

<div align="center">

<table>
  <tr>
    <td align="center">
      <img src="https://raw.githubusercontent.com/aliattia02/Morafek-CareMate/main/docs/screenshots/Screenshot%202026-04-14%20002400.png" width="200"/><br/>
      <sub><b>Login</b></sub>
    </td>
    <td align="center">
      <img src="https://raw.githubusercontent.com/aliattia02/Morafek-CareMate/main/docs/screenshots/Screenshot%202026-04-14%20002411.png" width="200"/><br/>
      <sub><b>Patient Home</b></sub>
    </td>
    <td align="center">
      <img src="https://raw.githubusercontent.com/aliattia02/Morafek-CareMate/main/docs/screenshots/Screenshot%202026-04-14%20002450.png" width="200"/><br/>
      <sub><b>Record Vitals</b></sub>
    </td>
  </tr>
  <tr>
    <td align="center">
      <img src="https://raw.githubusercontent.com/aliattia02/Morafek-CareMate/main/docs/screenshots/Screenshot%202026-04-14%20002423.png" width="200"/><br/>
      <sub><b>Visit History</b></sub>
    </td>
    <td align="center">
      <img src="https://raw.githubusercontent.com/aliattia02/Morafek-CareMate/main/docs/screenshots/Screenshot%202026-04-14%20002506.png" width="200"/><br/>
      <sub><b>Medical Profile</b></sub>
    </td>
    <td align="center">
      <img src="https://raw.githubusercontent.com/aliattia02/Morafek-CareMate/main/docs/screenshots/Screenshot%202026-04-14%20002439.png" width="200"/><br/>
      <sub><b>Manage Doctors</b></sub>
    </td>
  </tr>
  <tr>
    <td align="center" colspan="3">
      <img src="https://raw.githubusercontent.com/aliattia02/Morafek-CareMate/main/docs/screenshots/Screenshot%202026-04-14%20002519.png" width="200"/><br/>
      <sub><b>DSGVO Data Deletion</b></sub>
    </td>
  </tr>
</table>

</div>

### Doctor

<div align="center">

<table>
  <tr>
    <td align="center">
      <img src="https://raw.githubusercontent.com/aliattia02/Morafek-CareMate/main/docs/screenshots/Screenshot%202026-04-14%20002250.png" width="200"/><br/>
      <sub><b>Doctor Dashboard</b></sub>
    </td>
    <td align="center">
      <img src="https://raw.githubusercontent.com/aliattia02/Morafek-CareMate/main/docs/screenshots/Screenshot%202026-04-14%20002332.png" width="200"/><br/>
      <sub><b>Patient Vitals</b></sub>
    </td>
    <td align="center">
      <img src="https://raw.githubusercontent.com/aliattia02/Morafek-CareMate/main/docs/screenshots/Screenshot%202026-04-14%20002346.png" width="200"/><br/>
      <sub><b>Patient Messages</b></sub>
    </td>
  </tr>
</table>

</div>

---

## ✨ Features

### 🔐 Authentication
- Separate **Patient** and **Doctor** account types
- Secure login with long-lived mobile sessions — no unexpected logouts
- Forgot password via email
- **DSGVO-compliant account deletion** — permanently wipes all your data on request

### 📊 Patient Dashboard
- Blood pressure card with color-coded health status (Normal · Elevated · High · Crisis)
- Latest visit summary at a glance
- **SOS emergency button** — one tap to call emergency services
- Quick access to Visits, Messages, Documents, and Exercises
- Works **offline** — data is cached locally and synced when you're back online

### 💓 Vitals Logging
- Log blood pressure, pulse, weight, and notes
- Real-time health status badge as you type
- Readings saved offline and synced automatically

### 🏥 Clinical Visits
- Full visit history with diagnosis codes and expandable clinical notes
- Doctors record visits with chief complaint and diagnosis
- **AI-assisted diagnosis coding** — Gemini suggests ICD-10-GM codes based on the chief complaint

### 💬 Messaging
- Secure in-app messaging between patients and their doctors
- Unread message badges on all conversations

### 📁 Medical Documents
- Upload and organize lab reports, imaging, prescriptions, and more
- Color-coded categories for easy browsing
- Doctors have read-only access to patient documents

### 🏋️ Exercise Plans
- Doctor-assigned programs with video links and images
- Categories: Mobility · Strength · Balance · Breathing
- **Mark as Done** to track your progress

### 👨‍⚕️ Doctor Dashboard
- Full patient list with per-patient drill-down
- View and edit patient medical profiles
- Access vitals, visits, documents, exercises, and messages all in one place

### 🏥 Clinic Management
- Doctors can create and manage clinics
- Join or leave clinics freely
- Patients can browse and filter doctors by clinic

### 👤 Patient Profile & Data Export
- Full medical profile: blood type, allergies, conditions, medications, emergency contact
- **Export your complete health record** as a FHIR R4 Bundle (download or share)

---

## 🛠️ Tech Stack

| | |
|---|---|
| **Mobile & Web** | React Native (Expo) · TypeScript |
| **Backend** | Python (Flask) |
| **Database** | MongoDB Atlas |
| **File Storage** | Cloudinary |
| **AI** | Google Gemini |
| **Hosting** | Vercel (Web) · Render (API) |

---

## 🚀 Getting Started

### 🌐 Try it instantly — no setup needed
**[morafek-care-mate.vercel.app](https://morafek-care-mate.vercel.app/)** — use the demo accounts on the login screen.

### Run locally
```bash
# Backend
cd backend && python -m venv venv && source venv/bin/activate
pip install -r requirements.txt && cp .env.example .env
python main.py

# Mobile
cd mobile && npm install && cp .env.example .env && npm start
```

---

## 🚦 Feature Status

| Status | |
|---|---|
| ✅ Complete | Auth, vitals, visits, AI diagnosis assist, documents, exercises, messaging, clinics, doctor authorization, FHIR export, account deletion |
| 🔄 In Progress | Patient self-edit profile |
| 🔜 Planned | Connected sensors (heart rate, CGM, SpO2), push notifications, ePA integration |

---

## 🤝 Contributing

We welcome contributions of all kinds — bug fixes, features, documentation, translations.

1. **Sign the CLA** — add `I have read and agree to the Contributor License Agreement in CLA.md.` as a comment in your PR. This is required before any merge. See [CLA.md](CLA.md).
2. Fork the repo and create a feature branch from `main`.
3. Make your changes with clear, focused commits.
4. Open a Pull Request describing what you changed and why.

Please read [CONTRIBUTING.md](CONTRIBUTING.md) for full guidelines.

---

## 📄 License

Licensed under the **Apache License 2.0** — see [LICENSE](LICENSE) for details.

**Trademark notice:** The names "Morafek", "Morafek CareMate", and "Health Info Tech" are trademarks of Ali Attia / Health Info Tech. You may not use them without explicit written permission.

**Healthcare disclaimer:** This software is not a certified medical device and is not intended to diagnose, treat, cure, or prevent any disease. Deployers are solely responsible for regulatory compliance.

---

<div align="center">Built with ❤️ for better healthcare — © 2025 Ali Attia / Health Info Tech</div>