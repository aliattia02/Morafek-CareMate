"""
backend/services/gics_service.py
─────────────────────────────────────────────────────────────────────────────
gICS informed-consent service for Morafek CareMate.

Wraps the gICS SOAP web service so the rest of the backend can call simple
Python functions instead of dealing with XML envelopes.

Usage
-----
    from services.gics_service import gics

    consent_id = gics.get_or_create_consent(patient_id)   # → "gics-ok-ab3x9k2m" or None
    gics.revoke_consent(patient_id)                        # fire-and-forget, returns bool
    status = gics.get_consent_status(patient_id)           # "granted" | "revoked" | "unknown"

    if gics.is_available():
        consent_id = gics.get_or_create_consent(patient_id)

Architecture note
-----------------
The gICS SOAP endpoint is at:
    http://gics:8080/gics/gicsService          (Docker network)
    http://localhost:8082/gics/gicsService     (host machine — mapped to 8082)

The domain "morafek-data-sharing" must exist in gICS before this runs.
Create it once via the gICS admin UI at http://localhost:8082/gics-web/.

gICS being down NEVER raises — every method returns None / False / "unknown"
on RequestException, and MongoDB (patient_consents) is the fallback.

Environment variables
---------------------
GICS_URL      — base URL of the gICS container  (default: http://gics:8080)
GICS_DOMAIN   — consent domain name             (default: morafek-data-sharing)
GICS_TIMEOUT  — request timeout in seconds      (default: 5)
"""

from __future__ import annotations

import logging
import os
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from typing import Optional

import requests

logger = logging.getLogger(__name__)

# ─── Configuration ─────────────────────────────────────────────────────────────

GICS_BASE_URL = os.environ.get("GICS_URL", "http://gics:8080").rstrip("/")
GICS_DOMAIN   = os.environ.get("GICS_DOMAIN", "morafek-data-sharing")
GICS_TIMEOUT  = int(os.environ.get("GICS_TIMEOUT", "5"))

_SOAP_ENDPOINT = f"{GICS_BASE_URL}/gics/gicsService"

_SOAP_HEADERS = {
    "Content-Type": "text/xml; charset=utf-8",
    "SOAPAction": "",
}

# Policy name and version used inside the domain — must match what was
# configured in the gICS admin UI when the domain was set up.
_POLICY_NAME    = "data-sharing"
_POLICY_VERSION = "1.0"


# ─── SOAP envelope builders ────────────────────────────────────────────────────

def _envelope_add_consent(patient_id: str, domain: str) -> str:
    """Build the SOAP XML for addConsent."""
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
    xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
    xmlns:gics="http://consent.ttp.ganimed.icmvc.emau.org/">
  <soapenv:Header/>
  <soapenv:Body>
    <gics:addConsent>
      <consent>
        <patientIdentifier>
          <value>{_xml_escape(patient_id)}</value>
        </patientIdentifier>
        <consentTemplateKey>
          <domainName>{_xml_escape(domain)}</domainName>
          <name>{_POLICY_NAME}</name>
          <version>{_POLICY_VERSION}</version>
        </consentTemplateKey>
        <consentDates>
          <consentDate>{now_iso}</consentDate>
        </consentDates>
        <signatureIsFromGuardian>false</signatureIsFromGuardian>
      </consent>
    </gics:addConsent>
  </soapenv:Body>
</soapenv:Envelope>"""


def _envelope_revoke_consent(patient_id: str, domain: str) -> str:
    """Build the SOAP XML for revokeConsent."""
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
    xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
    xmlns:gics="http://consent.ttp.ganimed.icmvc.emau.org/">
  <soapenv:Header/>
  <soapenv:Body>
    <gics:revokeConsent>
      <patientIdentifier>
        <value>{_xml_escape(patient_id)}</value>
      </patientIdentifier>
      <consentTemplateKey>
        <domainName>{_xml_escape(domain)}</domainName>
        <name>{_POLICY_NAME}</name>
        <version>{_POLICY_VERSION}</version>
      </consentTemplateKey>
    </gics:revokeConsent>
  </soapenv:Body>
</soapenv:Envelope>"""


def _envelope_get_policy_states(patient_id: str, domain: str) -> str:
    """Build the SOAP XML for getCurrentPolicyStatesForPersonAndTemplate."""
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
    xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
    xmlns:gics="http://consent.ttp.ganimed.icmvc.emau.org/">
  <soapenv:Header/>
  <soapenv:Body>
    <gics:getCurrentPolicyStatesForPersonAndTemplate>
      <patientIdentifier>
        <value>{_xml_escape(patient_id)}</value>
      </patientIdentifier>
      <consentTemplateKey>
        <domainName>{_xml_escape(domain)}</domainName>
        <name>{_POLICY_NAME}</name>
        <version>{_POLICY_VERSION}</version>
      </consentTemplateKey>
    </gics:getCurrentPolicyStatesForPersonAndTemplate>
  </soapenv:Body>
</soapenv:Envelope>"""


def _xml_escape(value: str) -> str:
    """Minimal XML character escaping — mirrors gpas_service.py."""
    return (
        value
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )


# ─── Response parsers ──────────────────────────────────────────────────────────

def _parse_soap_tag(xml_text: str, tag: str) -> Optional[str]:
    """
    Extract the text of the first element whose local name matches *tag*
    in the SOAP response body.  Namespace-agnostic.  Returns None on failure.
    Mirrors _parse_soap_return() in gpas_service.py.
    """
    try:
        root = ET.fromstring(xml_text)
        for elem in root.iter():
            local = elem.tag.split("}")[-1] if "}" in elem.tag else elem.tag
            if local == tag and elem.text:
                return elem.text.strip()
    except ET.ParseError as exc:
        logger.error("gICS SOAP XML parse error: %s | raw: %.200s", exc, xml_text)
    return None


def _parse_consent_id(xml_text: str) -> Optional[str]:
    """
    Pull a consent ID from an addConsent response.
    gICS may use <consentId>, <id>, or <return> depending on version.
    """
    for tag in ("consentId", "id", "return"):
        val = _parse_soap_tag(xml_text, tag)
        if val:
            return val
    return None


def _parse_consent_status(xml_text: str) -> str:
    """
    Parse a getCurrentPolicyStates response.

    gICS uses <consentStatus>ACCEPTED</consentStatus> (or REVOKED / UNKNOWN /
    WITHDRAWN) inside the response body.

    Returns one of: "granted" | "revoked" | "unknown"
    """
    status_raw = _parse_soap_tag(xml_text, "consentStatus")
    if not status_raw:
        return "unknown"
    status_upper = status_raw.upper()
    if status_upper in ("ACCEPTED", "GRANTED", "VALID"):
        return "granted"
    if status_upper in ("REVOKED", "WITHDRAWN"):
        return "revoked"
    return "unknown"


# ─── Public service class ──────────────────────────────────────────────────────

class GICSService:
    """Thin wrapper around the gICS SOAP web service."""

    # ── Core operations ──────────────────────────────────────────────────────

    def get_or_create_consent(
        self,
        patient_id: str,
        domain: str = GICS_DOMAIN,
    ) -> Optional[str]:
        """
        Record a patient's consent in gICS for *domain*.

        Idempotent — calling this when consent already exists is safe;
        gICS returns the existing record rather than raising.

        Returns a consent ID string on success, or None if gICS is unreachable.
        Failure is logged but NEVER re-raised — MongoDB is the fallback store.
        """
        payload = _envelope_add_consent(patient_id, domain)
        try:
            resp = requests.post(
                _SOAP_ENDPOINT,
                data=payload.encode("utf-8"),
                headers=_SOAP_HEADERS,
                timeout=GICS_TIMEOUT,
            )
            resp.raise_for_status()
        except requests.RequestException as exc:
            logger.error("gICS get_or_create_consent request failed: %s", exc)
            return None

        consent_id = _parse_consent_id(resp.text)

        if consent_id:
            logger.info(
                "gICS consent recorded  domain=%s  patient=%.20s…  id=%s",
                domain, patient_id, consent_id,
            )
            return consent_id

        # addConsent can return an empty SOAP body on success (HTTP 200 but
        # no ID element).  Treat any 2xx as success and synthesise a stable ID.
        if resp.status_code < 300:
            logger.info(
                "gICS addConsent succeeded (no ID in body)  domain=%s  patient=%.20s…",
                domain, patient_id,
            )
            return f"gics-ok-{patient_id[:8]}"

        logger.error(
            "gICS addConsent failed. Status=%s  body=%.300s",
            resp.status_code, resp.text,
        )
        return None

    def revoke_consent(
        self,
        patient_id: str,
        domain: str = GICS_DOMAIN,
    ) -> bool:
        """
        Revoke a patient's consent in gICS.

        Intended as fire-and-forget: MongoDB is already updated before this
        is called, so the return value is informational only.

        Returns True on success, False if gICS is unreachable or errors.
        """
        payload = _envelope_revoke_consent(patient_id, domain)
        try:
            resp = requests.post(
                _SOAP_ENDPOINT,
                data=payload.encode("utf-8"),
                headers=_SOAP_HEADERS,
                timeout=GICS_TIMEOUT,
            )
            resp.raise_for_status()
            logger.info(
                "gICS consent revoked  domain=%s  patient=%.20s…",
                domain, patient_id,
            )
            return True
        except requests.RequestException as exc:
            logger.error("gICS revoke_consent request failed: %s", exc)
            return False

    def get_consent_status(
        self,
        patient_id: str,
        domain: str = GICS_DOMAIN,
    ) -> str:
        """
        Query the current policy state for *patient_id* in *domain*.

        Returns one of: "granted" | "revoked" | "unknown"
        Returns "unknown" on any network or parse failure — never raises.
        """
        payload = _envelope_get_policy_states(patient_id, domain)
        try:
            resp = requests.post(
                _SOAP_ENDPOINT,
                data=payload.encode("utf-8"),
                headers=_SOAP_HEADERS,
                timeout=GICS_TIMEOUT,
            )
            resp.raise_for_status()
        except requests.RequestException as exc:
            logger.error("gICS get_consent_status request failed: %s", exc)
            return "unknown"

        return _parse_consent_status(resp.text)

    # ── Health check ─────────────────────────────────────────────────────────

    def is_available(self) -> bool:
        """
        Return True if the gICS SOAP endpoint responds to a lightweight
        WSDL probe within the configured timeout.  Same pattern as gPAS.
        """
        try:
            resp = requests.get(
                f"{GICS_BASE_URL}/gics/gicsService?wsdl",
                timeout=GICS_TIMEOUT,
            )
            return resp.status_code == 200
        except requests.RequestException:
            return False


# ─── Singleton ─────────────────────────────────────────────────────────────────

gics = GICSService()
