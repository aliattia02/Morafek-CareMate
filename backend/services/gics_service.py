"""
backend/services/gics_service.py
─────────────────────────────────────────────────────────────────────────────
gICS informed-consent service for Morafek CareMate.

Wraps the gICS SOAP web service so the rest of the backend can call simple
Python functions instead of dealing with XML envelopes.

Usage
-----
    from services.gics_service import gics

    gics.add_consent(patient_id, template_id)         # raises RuntimeError on fail
    gics.revoke_consent(patient_id)                   # fire-and-forget, returns bool
    status = gics.get_consent_status(patient_id)      # "ACCEPTED" | "REJECTED" | "UNKNOWN"
                                                       # (collapses failures into "UNKNOWN")
    result = gics.get_consent_status_detailed(patient_id)  # {"status", "ok", "error"} —
                                                       # use this when a failed query must
                                                       # NOT be treated the same as a real
                                                       # "no consent" answer (added 2026-08-11,
                                                       # see get_consent_status_detailed())

Architecture note
-----------------
The gICS SOAP endpoint is at:
    http://gics:8080/gics/gicsService          (Docker network)
    http://localhost:8082/gics/gicsService     (host machine — mapped to 8082)

The domain "morafek-data-sharing" must exist in gICS before this runs.
Run gics_setup.py once after `docker compose up -d` to create the domain,
policy, module, and template.

    When creating the domain, set Signer-IDs to: morafek-patient-id
    This is the identifier type that all SOAP calls below use.

gICS being down NEVER raises in get_or_create_consent / revoke_consent /
get_consent_status. add_consent (strict variant) raises RuntimeError so the
caller can return 502 to the client and roll back gPAS.

SOAP API version
----------------
These envelopes target gICS 2.x (Mosaic Greifswald 2025.x).

Namespace (cm2, NOT the old consent namespace)
-----------------------------------------------
gICS 2025.x moved all consent operations to:
    CORRECT (2.x):  http://cm2.ttp.ganimed.icmvc.emau.org/
    WRONG   (1.x):  http://consent.ttp.ganimed.icmvc.emau.org/

addConsent envelope requirements (discovered via fix history in gics_setup.py)
-------------------------------------------------------------------------------
The following fields are ALL required for gICS 2025.2.x to accept a consent.
Omitting any one of them causes a SOAP fault or silent null record:

  Inside <key>:
    • <consentDate>       — xs:dateTime timestamp of this consent   (Fix J)
                            Must be a full xs:dateTime string (e.g. 2026-05-13T17:43:46Z).
                            A bare xs:date causes JAXB to silently default to epoch
                            → InvalidParameterException: consentDTO.key.consentDate

  Inside <consent> (JAXB base-class fields first, then derived):
    • <legacyTypeMapping/>                                           (Fix T)
    • <moduleStates> with full moduleStateDTO                        (Fix S)
    • <patientSignatureIsFromGuardian>                               (Fix T)
    • <patientSigningDate>                                           (Fix T)
    • <signature type="participant">                                 (Fix U)
    • <signature type="physician">   — second mandatory group        (Fix V)
    • <metaData/>                                                    (Fix S)
    • <scans/>

  moduleStates <value> must be a full moduleStateDTO, NOT a plain string:
    <value><consentState>ACCEPTED</consentState><key>…</key></value> (Fix S)

  <defaultConsentStatus> must be NOT_ASKED (not UNKNOWN) in the template.  (Fix W)

JAXB field ordering rules
--------------------------
JAXB uses alphabetical field order within each class level. The consentKey
fields inside <key> must follow the WSDL schema order, not strict alpha —
the working smoke test order is: consentTemplateKey → consentDate → signerIds.

For revokeConsent / getCurrentPolicyStatesForPersonAndTemplate the
consentKeyDTO (no consentDate) must have: consentTemplateKey → signerIds
(alphabetical: c < s).

Environment variables
---------------------
GICS_URL                    — base URL of the gICS container  (default: http://gics:8080)
GICS_DOMAIN                 — consent domain name             (default: morafek-data-sharing)
GICS_SIGNER_ID_TYPE         — signer-id type configured in the gICS domain
                              (default: morafek-patient-id)
GICS_TIMEOUT                — request timeout in seconds      (default: 10)
GICS_SIGNER_TYPE_PARTICIPANT— SignatureType.id for participant (default: participant)
GICS_SIGNER_TYPE_PHYSICIAN  — SignatureType.id for physician  (default: physician)
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

GICS_BASE_URL            = os.environ.get("GICS_URL",                    "http://gics:8080").rstrip("/")
GICS_DOMAIN              = os.environ.get("GICS_DOMAIN",                 "morafek-data-sharing")
GICS_SIGNER_ID_TYPE      = os.environ.get("GICS_SIGNER_ID_TYPE",         "morafek-patient-id")
GICS_TIMEOUT             = int(os.environ.get("GICS_TIMEOUT",            "10"))
GICS_SIGNER_PARTICIPANT  = os.environ.get("GICS_SIGNER_TYPE_PARTICIPANT", "participant")
GICS_SIGNER_PHYSICIAN    = os.environ.get("GICS_SIGNER_TYPE_PHYSICIAN",   "physician")

_SOAP_ENDPOINT = f"{GICS_BASE_URL}/gics/gicsService"

_SOAP_HEADERS = {
    "Content-Type": "text/xml; charset=utf-8",
    "SOAPAction": "",
}

# Correct namespace for gICS 2025.x consent operations
NS_CONSENT_OPS = "http://cm2.ttp.ganimed.icmvc.emau.org/"

# ── Constants matching gics_setup.py exactly ──────────────────────────────────
# Template key (used in consentTemplateKey)
_TEMPLATE_NAME    = "data-sharing"
_TEMPLATE_VERSION = "1.0"

# Policy key (within moduleStates — references the policy, not the template)
_POLICY_NAME    = "data-sharing"
_POLICY_VERSION = "1.0"

# Module key (referenced in moduleStates and moduleStateDTO.key)
_MODULE_NAME    = "data-sharing-module"
_MODULE_VERSION = "1.0"


# ─── XML helpers ───────────────────────────────────────────────────────────────

def _xml_escape(value: str) -> str:
    return (
        value
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _now_date() -> str:
    """Return today's date as YYYY-MM-DD.

    NOTE: gICS 2025.x JAXB cannot unmarshal a bare xs:date for consentDate —
    it silently defaults to epoch and then rejects with InvalidParameterException.
    Use _now_iso() (xs:dateTime) for <consentDate> in the consent key instead.
    This function is kept for any future xs:date-only fields.
    """
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


# ─── SOAP envelope builders ────────────────────────────────────────────────────

def _envelope_add_consent(patient_id: str, domain: str) -> str:
    """
    Build the SOAP XML for addConsent (gICS 2025.2.x).

    This envelope incorporates all fixes discovered iteratively in gics_setup.py
    (Fixes J, O, P, Q, S, T, U, V, W). Missing any one field causes a SOAP
    fault or silent null record in gICS.

    JAXB field order rules (alphabetical within each class level):
      consentLightDTO (base):  consentDates → key → legacyTypeMapping →
                               moduleStates → patientSignatureIsFromGuardian →
                               patientSigningDate → signature(s)
      consentDTO (derived):   metaData → scans

    consentKey field order (from working smoke-test, not strict alpha):
      consentTemplateKey → consentDate → signerIds
    """
    now      = _now_iso()   # xs:dateTime — used for all date fields including consentDate
    domain_e     = _xml_escape(domain)
    template_e   = _xml_escape(_TEMPLATE_NAME)
    template_v_e = _xml_escape(_TEMPLATE_VERSION)
    module_e     = _xml_escape(_MODULE_NAME)
    module_ver_e = _xml_escape(_MODULE_VERSION)
    patient_e    = _xml_escape(patient_id)
    id_type_e    = _xml_escape(GICS_SIGNER_ID_TYPE)
    part_e       = _xml_escape(GICS_SIGNER_PARTICIPANT)
    phys_e       = _xml_escape(GICS_SIGNER_PHYSICIAN)

    return f"""<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
    xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
    xmlns:gics="{NS_CONSENT_OPS}">
  <soapenv:Header/>
  <soapenv:Body>
    <gics:addConsent>
      <consent>
        <!-- consentLightDTO base fields — alphabetical order required by JAXB -->
        <consentDates>
          <legalConsentDate>{now}</legalConsentDate>
        </consentDates>
        <key>
          <!-- consentKey field order: consentTemplateKey → consentDate → signerIds -->
          <consentTemplateKey>
            <domainName>{domain_e}</domainName>
            <name>{template_e}</name>
            <version>{template_v_e}</version>
          </consentTemplateKey>
          <consentDate>{now}</consentDate>
          <signerIds>
            <idType>{id_type_e}</idType>
            <id>{patient_e}</id>
            <orderNumber>1</orderNumber>
          </signerIds>
        </key>
        <!-- legacyTypeMapping REQUIRED — absence misaligns subsequent JAXB fields -->
        <legacyTypeMapping/>
        <!-- moduleStates: value must be full moduleStateDTO, not a plain string (Fix S) -->
        <moduleStates>
          <entry>
            <key>
              <domainName>{domain_e}</domainName>
              <name>{module_e}</name>
              <version>{module_ver_e}</version>
            </key>
            <value>
              <consentState>ACCEPTED</consentState>
              <key>
                <domainName>{domain_e}</domainName>
                <name>{module_e}</name>
                <version>{module_ver_e}</version>
              </key>
            </value>
          </entry>
        </moduleStates>
        <patientSignatureIsFromGuardian>false</patientSignatureIsFromGuardian>
        <patientSigningDate>{now}</patientSigningDate>
        <!-- Participant signature — satisfies mandatory participants_or_guardians group (Fix U) -->
        <signature type="{part_e}">
          <signatureBase64>cGF0aWVudC1zaWduZWQ=</signatureBase64>
          <signingDate>{now}</signingDate>
        </signature>
        <!-- Physician signature — satisfies mandatory physician group (Fix V) -->
        <signature type="{phys_e}">
          <signatureBase64>cGh5c2ljaWFuLXNpZ25lZA==</signatureBase64>
          <signingDate>{now}</signingDate>
        </signature>
        <!-- consentDTO derived fields — must follow all base fields -->
        <metaData/>
        <scans/>
      </consent>
    </gics:addConsent>
  </soapenv:Body>
</soapenv:Envelope>"""


def _envelope_revoke_consent(patient_id: str, domain: str) -> str:
    """
    Build the SOAP XML for revokeConsent (gICS 2.x).

    consentKeyDTO field order (alphabetical JAXB): consentTemplateKey → signerIds.
    """
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
    xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
    xmlns:gics="{NS_CONSENT_OPS}">
  <soapenv:Header/>
  <soapenv:Body>
    <gics:revokeConsent>
      <consentKey>
        <!-- consentKeyDTO alphabetical order: consentTemplateKey → signerIds -->
        <consentTemplateKey>
          <domainName>{_xml_escape(domain)}</domainName>
          <name>{_xml_escape(_TEMPLATE_NAME)}</name>
          <version>{_xml_escape(_TEMPLATE_VERSION)}</version>
        </consentTemplateKey>
        <signerIds>
          <idType>{_xml_escape(GICS_SIGNER_ID_TYPE)}</idType>
          <id>{_xml_escape(patient_id)}</id>
          <orderNumber>1</orderNumber>
        </signerIds>
      </consentKey>
    </gics:revokeConsent>
  </soapenv:Body>
</soapenv:Envelope>"""


def _envelope_get_policy_states(patient_id: str, domain: str) -> str:
    """
    Build the SOAP XML for getCurrentPolicyStatesForPersonAndTemplate (gICS 2.x).

    consentKeyDTO field order (alphabetical JAXB): consentTemplateKey → signerIds.
    """
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
    xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
    xmlns:gics="{NS_CONSENT_OPS}">
  <soapenv:Header/>
  <soapenv:Body>
    <gics:getCurrentPolicyStatesForPersonAndTemplate>
      <consentKey>
        <!-- consentKeyDTO alphabetical order: consentTemplateKey → signerIds -->
        <consentTemplateKey>
          <domainName>{_xml_escape(domain)}</domainName>
          <name>{_xml_escape(_TEMPLATE_NAME)}</name>
          <version>{_xml_escape(_TEMPLATE_VERSION)}</version>
        </consentTemplateKey>
        <signerIds>
          <idType>{_xml_escape(GICS_SIGNER_ID_TYPE)}</idType>
          <id>{_xml_escape(patient_id)}</id>
          <orderNumber>1</orderNumber>
        </signerIds>
      </consentKey>
    </gics:getCurrentPolicyStatesForPersonAndTemplate>
  </soapenv:Body>
</soapenv:Envelope>"""


# ─── Response parsers ──────────────────────────────────────────────────────────

def _parse_soap_tag(xml_text: str, tag: str) -> Optional[str]:
    """Extract the text of the first element whose local name matches *tag*. Namespace-agnostic."""
    try:
        root = ET.fromstring(xml_text)
        for elem in root.iter():
            local = elem.tag.split("}")[-1] if "}" in elem.tag else elem.tag
            if local == tag and elem.text:
                return elem.text.strip()
    except ET.ParseError as exc:
        logger.error("gICS SOAP XML parse error: %s | raw: %.200s", exc, xml_text)
    return None


def _parse_soap_fault(xml_text: str) -> Optional[str]:
    """
    Return the faultstring text if the response is a SOAP fault, else None.

    Checks both <Fault> (standard) and <fault> (namespace variants).
    Also captures the full detail element when present for richer diagnostics.
    """
    if "<Fault" not in xml_text and "<fault" not in xml_text:
        return None

    fault_msg = _parse_soap_tag(xml_text, "faultstring") or _parse_soap_tag(xml_text, "message")
    detail    = _parse_soap_tag(xml_text, "detail") or _parse_soap_tag(xml_text, "cause")

    if fault_msg and detail:
        return f"{fault_msg} | detail: {detail[:300]}"
    return fault_msg or "Unknown SOAP fault"


def _parse_consent_status(xml_text: str) -> str:
    """Parse getCurrentPolicyStatesForPersonAndTemplate response → ACCEPTED | REJECTED | UNKNOWN."""
    status = _parse_soap_tag(xml_text, "consentState") or _parse_soap_tag(xml_text, "status")
    if not status:
        return "UNKNOWN"
    upper = status.upper()
    if upper in ("ACCEPTED", "CONSENT"):
        return "ACCEPTED"
    if upper in ("REJECTED", "REVOKED", "DECLINED", "WITHDRAWN"):
        return "REJECTED"
    return "UNKNOWN"


def _log_soap_fault(operation: str, patient_id: str, domain: str, fault: str, raw: str) -> None:
    """
    Log a SOAP fault with enough context to diagnose it.

    Logs at ERROR level with the full raw response body (truncated to 1 000
    chars) so the developer can see the exact gICS error without needing to
    attach a SOAP inspector.
    """
    logger.error(
        "gICS SOAP fault  op=%s  domain=%s  patient=%.20s…\n"
        "  fault  : %s\n"
        "  raw    : %.1000s",
        operation, domain, patient_id,
        fault,
        raw,
    )


_GICS_LOG_SOAP = os.environ.get("GICS_LOG_SOAP", "0").strip() in ("1", "true", "yes")


def _log_outbound_soap(operation: str, patient_id: str, domain: str, payload: str) -> None:
    """
    Log the outbound SOAP envelope so you can verify what's actually being sent.

    Normal operation  → DEBUG (invisible unless logging level is DEBUG).
    GICS_LOG_SOAP=1   → INFO  (always visible; set this when diagnosing issues).

    This is the single best way to verify a date-format or field-order problem
    before it hits gICS: grep the log for "SOAP outbound" and paste the XML
    into a SOAP client or diff it against the working gics_setup.py envelope.
    """
    msg = (
        "SOAP outbound  op=%s  domain=%s  patient=%.20s…\n%s",
        operation, domain, patient_id, payload,
    )
    if _GICS_LOG_SOAP:
        logger.info(*msg)
    else:
        logger.debug(*msg)


# ─── Public service class ──────────────────────────────────────────────────────

class GICSService:
    """Thin wrapper around the gICS 2.x SOAP web service."""

    def add_consent(
        self,
        patient_id: str,
        template_id: str = GICS_DOMAIN,
    ) -> dict:
        """
        Record a patient's consent in gICS (strict — raises RuntimeError on failure).

        The caller (consent_routes.accept_consent) should catch RuntimeError and
        return HTTP 502, optionally rolling back gPAS.

        Args:
            patient_id:  MongoDB patient _id string used as gICS signer ID.
            template_id: Consent domain name (defaults to GICS_DOMAIN).

        Returns:
            dict with {"consent_id": str}.

        Raises:
            RuntimeError: if gICS is unreachable, returns a SOAP fault, or
                          responds with a non-2xx HTTP status.  The error
                          message includes the SOAP faultstring so the caller
                          can log or surface it.
        """
        payload = _envelope_add_consent(patient_id, template_id)

        # Always log the outbound SOAP envelope at DEBUG.
        # To see it in the console without changing log level, temporarily
        # set GICS_LOG_SOAP=1 in your environment — it forces INFO-level logging.
        _log_outbound_soap("addConsent", patient_id, template_id, payload)

        try:
            resp = requests.post(
                _SOAP_ENDPOINT,
                data=payload.encode("utf-8"),
                headers=_SOAP_HEADERS,
                timeout=GICS_TIMEOUT,
            )
            resp.raise_for_status()
        except requests.RequestException as exc:
            raise RuntimeError(f"gICS unreachable: {exc}") from exc

        fault = _parse_soap_fault(resp.text)
        if fault:
            _log_soap_fault("addConsent", patient_id, template_id, fault, resp.text)
            logger.error(
                "addConsent outbound payload that triggered the fault:\n%s", payload
            )
            raise RuntimeError(f"gICS addConsent fault: {fault}")

        consent_id = _parse_soap_tag(resp.text, "consentId") or f"gics-ok-{patient_id[:8]}"
        logger.info(
            "gICS add_consent succeeded  domain=%s  patient=%.20s…  id=%s",
            template_id, patient_id, consent_id,
        )
        return {"consent_id": consent_id}

    def get_or_create_consent(
        self,
        patient_id: str,
        domain: str = GICS_DOMAIN,
    ) -> Optional[str]:
        """
        Soft variant of add_consent — logs failures instead of raising.
        Used by the legacy /api/patient/consent route.
        Returns a consent ID string on success, or None if gICS is unreachable.
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

        fault = _parse_soap_fault(resp.text)
        if fault:
            # "duplicate" / "already exists" is acceptable — consent already on record.
            if "duplicate" in fault.lower() or "already exist" in fault.lower():
                logger.info(
                    "gICS addConsent: consent already exists for patient %.20s… in domain %s — treating as success",
                    patient_id, domain,
                )
                return f"gics-existing-{patient_id[:8]}"

            _log_soap_fault("get_or_create_consent", patient_id, domain, fault, resp.text)
            return None

        consent_id = _parse_soap_tag(resp.text, "consentId")
        if consent_id:
            logger.info("gICS consent recorded  domain=%s  patient=%.20s…  id=%s",
                        domain, patient_id, consent_id)
            return consent_id

        if resp.status_code < 300:
            logger.info("gICS addConsent succeeded (no ID in body)  domain=%s  patient=%.20s…",
                        domain, patient_id)
            return f"gics-ok-{patient_id[:8]}"

        logger.error("gICS addConsent failed. Status=%s  body=%.300s", resp.status_code, resp.text)
        return None

    def revoke_consent(
        self,
        patient_id: str,
        domain: str = GICS_DOMAIN,
    ) -> bool:
        """
        Revoke a patient's consent in gICS.
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
        except requests.RequestException as exc:
            logger.error("gICS revoke_consent request failed: %s", exc)
            return False

        fault = _parse_soap_fault(resp.text)
        if fault:
            # "not found" is acceptable for revoke — nothing to revoke.
            if "not found" in fault.lower() or "unknown" in fault.lower() or "no consent" in fault.lower():
                logger.info(
                    "gICS revokeConsent: no consent found for patient %.20s… in domain %s — treating as success",
                    patient_id, domain,
                )
                return True

            _log_soap_fault("revokeConsent", patient_id, domain, fault, resp.text)
            return False

        logger.info("gICS consent revoked  domain=%s  patient=%.20s…", domain, patient_id)
        return True

    def get_consent_status_detailed(
        self,
        patient_id: str,
        template_id: str = GICS_DOMAIN,
    ) -> dict:
        """
        Query the current policy state for *patient_id*, distinguishing a
        genuine "no consent record" answer from gICS being unreachable or
        erroring.

        get_consent_status() (below) collapses all of the failure modes
        this method distinguishes into a single "UNKNOWN" string. That's
        the right contract for callers that only care about the tri-state
        ACCEPTED/REJECTED/UNKNOWN status and treat "gICS is down" and
        "gICS says nothing on file" the same way on purpose — e.g.
        accept_consent()'s idempotency check and the patient-facing
        GET /api/consent/status endpoint, both of which want "proceed as
        if not yet accepted" either way. It is the WRONG contract for a
        caller that must NOT silently treat a failed query the same as a
        real "no consent" answer — e.g. research_routes.py's sync job,
        which would otherwise flip research_eligible to False for a
        patient just because gICS timed out on their turn in the loop.
        Added 2026-08-11 for exactly that caller — see
        data-store-separation-reference.md §2.1.

        Returns
        -------
        {
          "status": "ACCEPTED" | "REJECTED" | "UNKNOWN",
          "ok":      bool  — True if this is gICS's genuine answer,
                              including a genuine "no record for this
                              patient" UNKNOWN. False if the call itself
                              failed — unreachable, a SOAP fault that
                              isn't "not found", or a response with no
                              parseable consent state — in which case
                              "status" is always "UNKNOWN" but should be
                              read as "we don't know," not "gICS said no."
          "error":   str | None — failure detail when ok is False.
        }
        """
        payload = _envelope_get_policy_states(patient_id, template_id)
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
            return {"status": "UNKNOWN", "ok": False, "error": f"gICS unreachable: {exc}"}

        fault = _parse_soap_fault(resp.text)
        if fault:
            # "not found" / "unknown signer" means no consent on record —
            # a genuine answer, not a failed call.
            if "not found" in fault.lower() or "unknown" in fault.lower():
                logger.debug(
                    "gICS get_consent_status: no record for patient %.20s… in domain %s",
                    patient_id, template_id,
                )
                return {"status": "UNKNOWN", "ok": True, "error": None}

            _log_soap_fault("getCurrentPolicyStates", patient_id, template_id, fault, resp.text)
            return {"status": "UNKNOWN", "ok": False, "error": fault}

        status = _parse_consent_status(resp.text)
        if status == "UNKNOWN":
            # Response came back with no SOAP fault, but with no
            # consentState/status tag either — an unexpected response
            # shape, not gICS telling us "no consent." Treat it as a
            # failed query so a distinguishing caller doesn't read it as
            # a real answer.
            logger.warning(
                "gICS get_consent_status: no consentState in response for "
                "patient %.20s… in domain %s — treating as a failed query, "
                "not a genuine UNKNOWN",
                patient_id, template_id,
            )
            return {"status": "UNKNOWN", "ok": False, "error": "no consentState in gICS response"}

        return {"status": status, "ok": True, "error": None}

    def get_consent_status(
        self,
        patient_id: str,
        template_id: str = GICS_DOMAIN,
    ) -> str:
        """
        Query the current policy state for *patient_id*.
        Returns "ACCEPTED" | "REJECTED" | "UNKNOWN". Never raises.

        Thin wrapper over get_consent_status_detailed() that drops the
        ok/error distinction, kept for every existing caller
        (accept_consent()'s idempotency check, GET /api/consent/status,
        diagnose_consent_stack()) that is written to treat "gICS
        unreachable" and "no consent on record" the same way. Callers that
        need to tell those apart should call get_consent_status_detailed()
        instead — currently only the research sync job does.
        """
        return self.get_consent_status_detailed(patient_id, template_id)["status"]

    def is_available(self) -> bool:
        """Return True if the gICS SOAP endpoint is reachable."""
        try:
            resp = requests.get(
                f"{GICS_BASE_URL}/gics/gicsService?wsdl",
                timeout=GICS_TIMEOUT,
            )
            return resp.status_code == 200
        except requests.RequestException:
            return False

    def check_and_diagnose(self, domain: str = GICS_DOMAIN) -> dict:
        """
        Run a lightweight diagnostic and return a status dict.

        Useful for the /api/health endpoint or operator tooling.

        Returns::

            {
                "reachable": bool,
                "wsdl_ok":   bool,
                "domain":    str,
                "endpoint":  str,
                "signer_id_type": str,
                "template":  {"name": str, "version": str},
                "module":    {"name": str, "version": str},
                "participant_signer": str,
                "physician_signer":   str,
            }
        """
        reachable = self.is_available()
        return {
            "reachable":          reachable,
            "wsdl_ok":            reachable,
            "domain":             domain,
            "endpoint":           _SOAP_ENDPOINT,
            "signer_id_type":     GICS_SIGNER_ID_TYPE,
            "template":           {"name": _TEMPLATE_NAME,  "version": _TEMPLATE_VERSION},
            "module":             {"name": _MODULE_NAME,     "version": _MODULE_VERSION},
            "participant_signer": GICS_SIGNER_PARTICIPANT,
            "physician_signer":   GICS_SIGNER_PHYSICIAN,
        }


# ─── Singleton ─────────────────────────────────────────────────────────────────

gics = GICSService()