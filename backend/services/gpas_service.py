"""
backend/services/gpas_service.py
─────────────────────────────────────────────────────────────────────────────
gPAS pseudonymisation service for Morafek CareMate.

Wraps the gPAS SOAP web service so the rest of the backend can call simple
Python functions instead of dealing with XML envelopes.

Usage
-----
    from services.gpas_service import gpas

    # Get-or-create a pseudonym for a patient (called at registration)
    psn = gpas.get_or_create("mongo-object-id-here")   # → "AB3X9K2M1Q"

    # Resolve a pseudonym back to the original ID (de-pseudonymise)
    original = gpas.resolve("AB3X9K2M1Q")               # → "mongo-object-id-here"

    # Check availability without raising
    if gpas.is_available():
        psn = gpas.get_or_create(patient_id)

Architecture note
-----------------
The gPAS SOAP endpoint is at:
    http://gpas:8080/gpas/gpasService          (Docker network)
    http://localhost:8080/gpas/gpasService     (host machine)

The domain "morafek-patients" must exist in gPAS before this runs.
Create it once via the gPAS web UI at http://localhost:8080/gpas-web/.

Environment variables
---------------------
GPAS_URL      — base URL of the gPAS container  (default: http://gpas:8080)
GPAS_DOMAIN   — pseudonym domain name           (default: morafek-patients)
GPAS_TIMEOUT  — request timeout in seconds      (default: 5)
"""

from __future__ import annotations

import logging
import os
import xml.etree.ElementTree as ET
from functools import lru_cache
from typing import Optional

import requests

logger = logging.getLogger(__name__)

# ─── Configuration ─────────────────────────────────────────────────────────────

GPAS_BASE_URL = os.environ.get("GPAS_URL", "http://gpas:8080").rstrip("/")
GPAS_DOMAIN   = os.environ.get("GPAS_DOMAIN", "morafek-patients")
GPAS_TIMEOUT  = int(os.environ.get("GPAS_TIMEOUT", "5"))

_SOAP_ENDPOINT = f"{GPAS_BASE_URL}/gpas/gpasService"

_SOAP_HEADERS = {
    "Content-Type": "text/xml; charset=utf-8",
    "SOAPAction": "",
}

# XML namespace used in gPAS SOAP responses
_NS = {
    "soap": "http://schemas.xmlsoap.org/soap/envelope/",
    "psn":  "http://psn.ttp.ganimed.icmvc.emau.org/",
}


# ─── SOAP envelope builders ────────────────────────────────────────────────────

def _envelope_get_or_create(original_value: str, domain: str) -> str:
    """Build the SOAP XML for getOrCreatePseudonymFor."""
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
    xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
    xmlns:psn="http://psn.ttp.ganimed.icmvc.emau.org/">
  <soapenv:Header/>
  <soapenv:Body>
    <psn:getOrCreatePseudonymFor>
      <value>{_xml_escape(original_value)}</value>
      <domainName>{_xml_escape(domain)}</domainName>
    </psn:getOrCreatePseudonymFor>
  </soapenv:Body>
</soapenv:Envelope>"""


def _envelope_get_value(pseudonym: str, domain: str) -> str:
    """Build the SOAP XML for getValueFor (de-pseudonymise)."""
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
    xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
    xmlns:psn="http://psn.ttp.ganimed.icmvc.emau.org/">
  <soapenv:Header/>
  <soapenv:Body>
    <psn:getValueFor>
      <psn>{_xml_escape(pseudonym)}</psn>
      <domainName>{_xml_escape(domain)}</domainName>
    </psn:getValueFor>
  </soapenv:Body>
</soapenv:Envelope>"""


def _envelope_delete_pseudonym(original_value: str, domain: str) -> str:
    """Build the SOAP XML for deleteEntry (remove a pseudonym mapping)."""
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
    xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
    xmlns:psn="http://psn.ttp.ganimed.icmvc.emau.org/">
  <soapenv:Header/>
  <soapenv:Body>
    <psn:deleteEntry>
      <value>{_xml_escape(original_value)}</value>
      <domainName>{_xml_escape(domain)}</domainName>
    </psn:deleteEntry>
  </soapenv:Body>
</soapenv:Envelope>"""


def _xml_escape(value: str) -> str:
    """Minimal XML character escaping."""
    return (
        value
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )


# ─── Response parsers ──────────────────────────────────────────────────────────

def _parse_soap_return(xml_text: str, tag: str) -> Optional[str]:
    """
    Extract the text of the first element whose local name matches *tag*
    in the SOAP response body.  Returns None on failure.
    """
    try:
        root = ET.fromstring(xml_text)
        # Walk the tree; namespace-agnostic search via local name
        for elem in root.iter():
            local = elem.tag.split("}")[-1] if "}" in elem.tag else elem.tag
            if local == tag and elem.text:
                return elem.text.strip()
    except ET.ParseError as exc:
        logger.error("gPAS SOAP XML parse error: %s | raw: %.200s", exc, xml_text)
    return None


def _parse_soap_fault(xml_text: str) -> Optional[str]:
    """
    Return the faultstring text if the response is a SOAP fault, else None.

    Checked BEFORE raise_for_status() so that HTTP 500 responses carrying a
    meaningful <faultstring> (e.g. "domain not found: morafek-patients") are
    surfaced to the caller instead of being replaced by the generic HTTPError
    message which contains only the status code and URL.
    """
    if "<Fault" not in xml_text and "<fault" not in xml_text:
        return None

    fault_msg = _parse_soap_return(xml_text, "faultstring") or _parse_soap_return(xml_text, "message")
    detail    = _parse_soap_return(xml_text, "detail") or _parse_soap_return(xml_text, "cause")

    if fault_msg and detail:
        return f"{fault_msg} | detail: {detail[:300]}"
    return fault_msg or "Unknown SOAP fault"


# ─── Public service class ──────────────────────────────────────────────────────

class GPASService:
    """Thin wrapper around the gPAS SOAP web service."""

    # ── Core operations ──────────────────────────────────────────────────────

    def get_or_create_pseudonym(
        self,
        original_id: str,
        domain: str = GPAS_DOMAIN,
    ) -> str:
        """
        Request a pseudonym for *original_id* in *domain* (strict variant — raises on failure).

        Unlike get_or_create() this method raises RuntimeError on any failure so the
        caller can roll back gICS consent and return 502 to the client.

        Args:
            original_id: The original patient identifier (MongoDB _id string).
            domain:      The gPAS pseudonym domain.

        Returns:
            Full pseudonym string.

        Raises:
            RuntimeError: if gPAS is unreachable or returns no pseudonym.
        """
        payload = _envelope_get_or_create(original_id, domain)
        try:
            resp = requests.post(
                _SOAP_ENDPOINT,
                data=payload.encode("utf-8"),
                headers=_SOAP_HEADERS,
                timeout=GPAS_TIMEOUT,
            )
        except requests.RequestException as exc:
            raise RuntimeError(f"gPAS unreachable: {exc}") from exc

        # Parse the SOAP fault BEFORE raise_for_status() so that an HTTP 500
        # carrying a meaningful <faultstring> (e.g. "domain not found:
        # morafek-patients") is surfaced rather than discarded.
        fault = _parse_soap_fault(resp.text)
        if fault:
            logger.error(
                "gPAS getOrCreatePseudonymFor fault  domain=%s  original=%.20s…\n"
                "  fault: %s\n  raw: %.500s",
                domain, original_id, fault, resp.text,
            )
            raise RuntimeError(f"gPAS SOAP fault: {fault}")

        try:
            resp.raise_for_status()
        except requests.HTTPError as exc:
            raise RuntimeError(
                f"gPAS HTTP error {resp.status_code}: {resp.text[:300]}"
            ) from exc

        pseudonym = (
            _parse_soap_return(resp.text, "psn")
            or _parse_soap_return(resp.text, "return")
        )
        if not pseudonym:
            raise RuntimeError(
                f"gPAS returned no pseudonym. Status={resp.status_code}  body={resp.text[:200]}"
            )

        logger.info(
            "gPAS get_or_create_pseudonym: domain=%s  original=%.20s…  psn=%s",
            domain, original_id, pseudonym,
        )
        return pseudonym

    def delete_pseudonym(
        self,
        original_id: str,
        domain: str = GPAS_DOMAIN,
    ) -> bool:
        """
        Delete the pseudonym entry for *original_id* from *domain* (strict — raises on failure).

        Args:
            original_id: The original patient identifier whose pseudonym mapping to remove.
            domain:      The gPAS pseudonym domain.

        Returns:
            True on success.

        Raises:
            RuntimeError: if gPAS is unreachable or returns a fault response.
        """
        payload = _envelope_delete_pseudonym(original_id, domain)
        try:
            resp = requests.post(
                _SOAP_ENDPOINT,
                data=payload.encode("utf-8"),
                headers=_SOAP_HEADERS,
                timeout=GPAS_TIMEOUT,
            )
        except requests.RequestException as exc:
            raise RuntimeError(f"gPAS unreachable during delete: {exc}") from exc

        # Parse SOAP fault BEFORE raise_for_status() — an HTTP 500 carrying
        # <faultstring>domain not found: morafek-patients</faultstring> must be
        # surfaced to the caller rather than replaced by a generic HTTPError.
        fault = _parse_soap_fault(resp.text)
        if fault:
            # "entry not found" / "unknown" means nothing to delete — treat as success.
            fault_lower = fault.lower()
            if "not found" in fault_lower or "unknown" in fault_lower:
                logger.info(
                    "gPAS deleteEntry: entry not found for original=%.20s… (already gone)",
                    original_id,
                )
                return True
            logger.error(
                "gPAS deleteEntry fault  domain=%s  original=%.20s…\n"
                "  fault: %s\n  raw: %.500s",
                domain, original_id, fault, resp.text,
            )
            raise RuntimeError(f"gPAS SOAP fault during delete: {fault}")

        try:
            resp.raise_for_status()
        except requests.HTTPError as exc:
            raise RuntimeError(
                f"gPAS HTTP error {resp.status_code} during delete: {resp.text[:300]}"
            ) from exc

        logger.info(
            "gPAS pseudonym deleted: domain=%s  original=%.20s…",
            domain, original_id,
        )
        return True

    def get_or_create(
        self,
        original_value: str,
        domain: str = GPAS_DOMAIN,
    ) -> Optional[str]:
        """
        Request a pseudonym for *original_value* in *domain*.

        Creates one if it doesn't exist yet (idempotent — safe to call on
        every patient registration; gPAS always returns the same pseudonym
        for the same input in the same domain).

        Returns the pseudonym string, or None if gPAS is unreachable.
        """
        payload = _envelope_get_or_create(original_value, domain)
        try:
            resp = requests.post(
                _SOAP_ENDPOINT,
                data=payload.encode("utf-8"),
                headers=_SOAP_HEADERS,
                timeout=GPAS_TIMEOUT,
            )
            resp.raise_for_status()
        except requests.RequestException as exc:
            logger.error("gPAS get_or_create request failed: %s", exc)
            return None

        # gPAS 2025.2.x uses <psn>; older versions used <return> — try both.
        pseudonym = _parse_soap_return(resp.text, "psn") or _parse_soap_return(resp.text, "return")
        if pseudonym:
            logger.info(
                "gPAS pseudonym obtained for domain=%s  original=%.20s…  psn=%s",
                domain, original_value, pseudonym,
            )
        else:
            logger.error(
                "gPAS returned no pseudonym. Status=%s  body=%.300s",
                resp.status_code, resp.text,
            )
        return pseudonym

    def resolve(
        self,
        pseudonym: str,
        domain: str = GPAS_DOMAIN,
    ) -> Optional[str]:
        """
        De-pseudonymise: resolve *pseudonym* back to the original value.

        Returns the original string, or None if not found / gPAS is down.
        Only authorised services (Treuhandstelle role) should call this.
        """
        payload = _envelope_get_value(pseudonym, domain)
        try:
            resp = requests.post(
                _SOAP_ENDPOINT,
                data=payload.encode("utf-8"),
                headers=_SOAP_HEADERS,
                timeout=GPAS_TIMEOUT,
            )
            resp.raise_for_status()
        except requests.RequestException as exc:
            logger.error("gPAS resolve request failed: %s", exc)
            return None

        # gPAS 2025.2.x uses <return> for de-pseudonymisation (getValueFor response)
        original = _parse_soap_return(resp.text, "return") or _parse_soap_return(resp.text, "value")
        return original

    # ── Health check ─────────────────────────────────────────────────────────

    def is_available(self) -> bool:
        """
        Return True if the gPAS SOAP endpoint responds to a lightweight
        HTTP probe within the configured timeout.

        Use this in health-check routes or before bulk operations.
        """
        try:
            resp = requests.get(
                f"{GPAS_BASE_URL}/gpas/gpasService?wsdl",
                timeout=GPAS_TIMEOUT,
            )
            return resp.status_code == 200
        except requests.RequestException:
            return False

    def check_and_diagnose(self, domain: str = GPAS_DOMAIN) -> dict:
        """
        Return a structured diagnostic dict for the /api/consent/diagnose endpoint.

        Keys
        ----
        reachable   : bool   — True if the gPAS SOAP endpoint is reachable
        domain_ok   : bool   — True if *domain* exists and a round-trip pseudonym
                               lookup succeeds (probe value is never stored)
        domain      : str    — the domain that was tested
        endpoint    : str    — the SOAP endpoint URL
        error       : str|None — human-readable error message, or None on full success
        """
        result: dict = {
            "reachable":  False,
            "domain_ok":  False,
            "domain":     domain,
            "endpoint":   _SOAP_ENDPOINT,
            "error":      None,
        }

        # Step 1 — can we reach the WSDL at all?
        try:
            wsdl_resp = requests.get(
                f"{GPAS_BASE_URL}/gpas/gpasService?wsdl",
                timeout=GPAS_TIMEOUT,
            )
            result["reachable"] = wsdl_resp.status_code == 200
        except requests.RequestException as exc:
            result["error"] = f"gPAS unreachable: {exc}"
            return result

        if not result["reachable"]:
            result["error"] = f"gPAS WSDL returned HTTP {wsdl_resp.status_code}"
            return result

        # Step 2 — does the domain exist?  Use a harmless probe value that we
        # immediately discard; getOrCreatePseudonymFor is idempotent so the
        # same probe value will always produce the same pseudonym without
        # polluting the domain with real data.
        _PROBE = "__gpas_diagnose_probe__"
        payload = _envelope_get_or_create(_PROBE, domain)
        try:
            resp = requests.post(
                _SOAP_ENDPOINT,
                data=payload.encode("utf-8"),
                headers=_SOAP_HEADERS,
                timeout=GPAS_TIMEOUT,
            )
        except requests.RequestException as exc:
            result["error"] = f"gPAS SOAP request failed: {exc}"
            return result

        fault = _parse_soap_fault(resp.text)
        if fault:
            result["error"] = f"gPAS SOAP fault: {fault}"
            return result

        pseudonym = (
            _parse_soap_return(resp.text, "psn")
            or _parse_soap_return(resp.text, "return")
        )
        if pseudonym:
            result["domain_ok"] = True
        else:
            result["error"] = (
                f"gPAS reachable but returned no pseudonym for domain '{domain}'. "
                "Check that the domain exists in the gPAS web UI."
            )

        return result


# ─── Singleton ─────────────────────────────────────────────────────────────────

gpas = GPASService()