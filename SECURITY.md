# Security Policy

Morafek CareMate processes healthcare-related data and must be handled with strict confidentiality.

## Supported Versions

Security fixes are applied to the latest `main` branch only.

## Reporting a Vulnerability (Private Disclosure Required)

**Do not open public GitHub issues for security vulnerabilities.**

Please report vulnerabilities privately using **GitHub Security Advisories**:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Provide reproduction steps, impact, and affected files/paths.

If Security Advisories are unavailable to you, contact the maintainer privately via GitHub:
https://github.com/aliattia02

## What to Include

- Vulnerability type and impact
- Affected components (backend / mobile / both)
- Reproduction steps or proof of concept
- Suggested remediation if available

## Response Expectations

We aim to acknowledge all reports promptly and coordinate a fix and responsible disclosure timeline before any public announcement.

## Scope

Areas of particular interest:
- Authentication and session management
- Patient data access controls (authorization between patients and doctors)
- FHIR export endpoints (data leakage)
- File upload handling (Cloudinary integration)
- API endpoint security (Flask backend)

## Out of Scope

- Vulnerabilities in third-party services (MongoDB Atlas, Cloudinary, Vercel, Render) — report these to the respective vendors.
- Issues that require physical access to a device.
- Social engineering attacks.

## Data Sensitivity Notice

Never include real patient data, tokens, credentials, or production logs in vulnerability reports. Use only synthetic or demo data.