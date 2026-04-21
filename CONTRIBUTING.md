# Contributing to Morafek CareMate

Thanks for your interest in contributing to **Morafek CareMate** 🎉

This project is a FHIR R4-native personal health record app (Flask backend + React Native/Expo frontend) and handles healthcare-related workflows. Please keep changes secure, privacy-aware, and standards-focused.

---

## ⚠️ CLA — Required Before Your First PR Is Merged

All contributors must sign the **Contributor License Agreement** before any Contribution can be merged.

**How to sign:** Add this exact comment to your Pull Request:

```
I have read and agree to the Contributor License Agreement in CLA.md.
```

Your GitHub username and the comment date serve as your electronic signature. A maintainer will label your PR `cla-signed`. You only need to do this once. Read the full agreement in [CLA.md](CLA.md).

---

## License

By contributing, you agree your Contributions are licensed under the **Apache License 2.0** and that the Licensor retains the right to relicense them under commercial terms, as described in the CLA.

---

## Ground Rules

- Do not commit secrets, credentials, or patient data.
- Keep DSGVO/GDPR and healthcare privacy requirements in mind.
- Prefer small, focused pull requests over large sweeping changes.
- Keep public discussions free of sensitive data.
- Be respectful — see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

---

## Development Setup

### Backend (Flask)

```bash
cd backend
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env       # fill in your local values
python main.py
```

### Mobile (Expo)

```bash
cd mobile
npm install
cp .env.example .env       # fill in your local values
npm start
```

---

## Branching & Pull Requests

- Create a feature branch from `main` (e.g., `feature/add-spo2-vitals`).
- Open a Pull Request to `main`.
- Do **not** push directly to `main`.
- Ensure all CI checks pass before requesting review.

---

## Pull Request Checklist

- [ ] CLA signed (comment added to PR)
- [ ] Scope is limited and clearly described
- [ ] No secrets, credentials, or patient data included
- [ ] API/frontend changes described in the PR body
- [ ] Relevant type checks or tests have been run
- [ ] Security and privacy impact considered

---

## What We're Looking For

Good first contributions:

- Bug fixes with a clear reproduction case
- Documentation improvements or translations (Arabic / German / English)
- Test coverage additions
- Accessibility improvements in the mobile UI

Bigger contributions (please open an issue first to discuss):

- New FHIR resource types
- New clinical modules
- ePA or DiGA integration
- Sensor connectivity (CGM, SpO2, heart rate)

---

## Reporting Security Issues

Please do **not** open public issues for vulnerabilities.
Use private disclosure through **GitHub Security Advisories** as described in [SECURITY.md](SECURITY.md).