# Contributing to Morafek CareMate

Thanks for your interest in contributing to **Morafek CareMate**.

This project is a FHIR R4-native personal health record app (Flask backend + React Native/Expo frontend) and handles healthcare-related workflows. Please keep changes secure, privacy-aware, and standards-focused.

## License

By contributing, you agree your contributions are licensed under the repository's **Business Source License 1.1 (BSL 1.1)**.

## Ground Rules

- Do not commit secrets, credentials, or patient data.
- Keep DSGVO/GDPR and healthcare privacy requirements in mind.
- Prefer small, focused pull requests.
- Keep public discussions free of sensitive data.

## Development Setup

### Backend (Flask)

```bash
cd backend
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
python main.py
```

### Mobile (Expo)

```bash
cd mobile
npm install
npm start
```

## Branching & Pull Requests

- Create a feature branch from `main`.
- Open a Pull Request to `main`.
- Do **not** push directly to `main`.
- Ensure CI checks pass before requesting review.

## Pull Request Checklist

- [ ] Scope is limited and clearly described
- [ ] No secrets or sensitive data included
- [ ] API/frontend changes are documented in PR description
- [ ] Type checks/tests relevant to the change are run
- [ ] Security/privacy impact considered

## Reporting Security Issues

Please do **not** open public issues for vulnerabilities.
Use private disclosure through **GitHub Security Advisories** as described in `SECURITY.md`.
