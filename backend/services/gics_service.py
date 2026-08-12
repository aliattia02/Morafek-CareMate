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

Fixed 2026-08-12 — both operations named above turned out not to exist in
this gICS version's WSDL at all (confirmed via live SOAP faults: "was not
recognized. Does it exist in service WSDL?" for each). Replaced with
refuseConsent and getPolicyStatesForPolicyNameAndSignerIds respectively —
see _envelope_revoke_consent() and _envelope_get_policy_states() below for
the real, verified-working shapes. This paragraph is left as-is for
historical context on the JAXB ordering investigation; it no longer
describes what the code actually calls.

Environment variables
---------------------
GICS_URL                    — base URL of the gICS container  (default: http://gics:8080)
GICS_DOMAIN                 — consent domain name             (default: morafek-data-sharing)
GICS_SIGNER_ID_TYPE         — signer-id type configured in the gICS domain
                              (default: morafek-patient-id)
GICS_TIMEOUT                — request timeout in seconds      (default: 10)
GICS_SIGNER_TYPE_PARTICIPANT— SignatureType.id for participant (default: participant)
GICS_SIGNER_TYPE_PHYSICIAN  — SignatureType.id for physician  (default: physician)
GICS_TEMPLATE_NAME          — consent template key (default: data-sharing) — MUST match
                              an actual template in GICS_DOMAIN, exactly
GICS_TEMPLATE_VERSION       — consent template version (default: 1.0)
GICS_MODULE_NAME            — consent module key (default: data-sharing-module) — MUST
                              match an actual module in GICS_DOMAIN, exactly
GICS_MODULE_VERSION         — consent module version (default: 1.0)
GICS_POLICY_NAME            — consent policy key (default: data-sharing) — used by
                              getPolicyStatesForPolicyNameAndSignerIds (status queries)
GICS_POLICY_VERSION         — consent policy version (default: 1.0) — not currently
                              sent in any envelope (that operation takes a plain
                              policyName string, no version), kept for parity
GICS_WITHDRAWAL_TEMPLATE_NAME    — withdrawal (REVOCATION-type) template key
                                   (default: withdrawal_wearable_health_data) — used
                                   by refuseConsent (revoke_consent()). MUST share
                                   the same module as GICS_TEMPLATE_NAME above.
GICS_WITHDRAWAL_TEMPLATE_VERSION — withdrawal template version (default: 1.0)
"""

from __future__ import annotations

import html
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

# ── Consent template/module/policy identity ───────────────────────────────────
# These must match an actual template/module/policy configured in gICS's admin
# UI for GICS_DOMAIN, exactly (name + version) — gICS does not resolve these
# dynamically, and a mismatch fails closed as an unhandled 500 from gICS
# (not a clean SOAP fault), surfaced to the client as 502. Originally hardcoded
# to match what gics_setup.py provisions ("data-sharing" / "data-sharing-module"),
# now overridable via env vars so switching the active policy in gICS's admin
# UI (e.g. to a new template) doesn't require a code change — just update these
# to match. See data-store-separation-reference.md / the 2026-08-12 ENRICH
# policy migration notes for why this became configurable.

# Template key (used in consentTemplateKey) — the CONSENT-type document,
# submitted by addConsent / used as the reference document for status reads.
_TEMPLATE_NAME    = os.environ.get("GICS_TEMPLATE_NAME",    "data-sharing")
_TEMPLATE_VERSION = os.environ.get("GICS_TEMPLATE_VERSION", "1.0")

# Withdrawal template key — the REVOCATION-type document, submitted by
# refuseConsent (revoke_consent()). Added 2026-08-12: previously revoke
# reused _TEMPLATE_NAME/_TEMPLATE_VERSION above, filing every withdrawal
# under the CONSENT document instead of a proper Widerruf record — gICS's
# own domain model treats these as distinct document types (CONSENT /
# REVOCATION / REFUSAL), with separate admin-UI sections for each. This
# template MUST have the same module (and therefore the same policy)
# assigned as the CONSENT template above — status reads
# (getPolicyStatesForPolicyNameAndSignerIds) query by policy name across
# the whole domain, not scoped to one template, so as long as both
# templates share the module, a withdrawal recorded here is still visible
# through the exact same status-read code path as before. Verified live
# before wiring this in: refuseConsent against this template succeeds and
# getPolicyStatesForPolicyNameAndSignerIds picks up the resulting REFUSED
# status via the shared policy, unchanged.
_WITHDRAWAL_TEMPLATE_NAME    = os.environ.get("GICS_WITHDRAWAL_TEMPLATE_NAME",    "withdrawal_wearable_health_data")
_WITHDRAWAL_TEMPLATE_VERSION = os.environ.get("GICS_WITHDRAWAL_TEMPLATE_VERSION", "1.0")

# Policy key — used by getPolicyStatesForPolicyNameAndSignerIds (status
# queries, fixed 2026-08-12). addConsent's moduleStates keys the module, not
# the policy, so _POLICY_NAME isn't used there. _POLICY_VERSION isn't sent
# in any envelope (that operation takes a plain policyName string, no
# version) — kept configurable for parity/documentation.
_POLICY_NAME    = os.environ.get("GICS_POLICY_NAME",    "data-sharing")
_POLICY_VERSION = os.environ.get("GICS_POLICY_VERSION", "1.0")

# Module key (referenced in moduleStates and moduleStateDTO.key)
_MODULE_NAME    = os.environ.get("GICS_MODULE_NAME",    "data-sharing-module")
_MODULE_VERSION = os.environ.get("GICS_MODULE_VERSION", "1.0")


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
    Build the SOAP XML for refuseConsent (gICS 2.x).

    Fixed 2026-08-12 — this previously built revokeConsent, which does not
    exist in this gICS version's WSDL at all (confirmed via a live SOAP
    fault: "Message part ...revokeConsent was not recognized. Does it
    exist in service WSDL?", HTTP 500) — the exact same class of bug as
    the getCurrentPolicyStatesForPersonAndTemplate one fixed earlier this
    session. Because revoke_consent() below treats most fault text as a
    tolerable "nothing to revoke" success, and the route that calls it
    (consent_routes.py::revoke_consent_strict()) proceeds to mark MongoDB
    revoked regardless of gICS's answer, this failed silently: the app
    reported success, MongoDB said "revoked", but gICS's own record never
    changed — verified live by checking a real patient's status
    immediately after using the app's revoke button: still ACCEPTED.

    refuseConsent takes consentTemplateKey (unwrapped — NOT nested inside
    a <consentKey>, unlike revokeConsent's shape) + signerIds. Verified
    live: calling it against a patient with an ACCEPTED consent appends a
    new signed-policy record with status REFUSED — gICS keeps the full
    history rather than overwriting the prior record. See
    get_consent_status_detailed() for how the "latest by consentDate, not
    first in document order" read side accounts for that.

    Updated 2026-08-12, later same day — now references the dedicated
    REVOCATION-type withdrawal template (_WITHDRAWAL_TEMPLATE_NAME) instead
    of reusing the CONSENT template (_TEMPLATE_NAME). Filing a withdrawal
    under the same document as the original consent worked (gICS doesn't
    enforce document Type for this operation) but was semantically wrong —
    every revoke was showing up in gICS's admin UI under "Consents"
    instead of its own "Withdrawals" section. The withdrawal template
    shares the same module (and therefore the same policy) as the consent
    template, so the read side needs no changes — verified live before
    this was wired in.
    """
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
    xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
    xmlns:gics="{NS_CONSENT_OPS}">
  <soapenv:Header/>
  <soapenv:Body>
    <gics:refuseConsent>
      <consentTemplateKey>
        <domainName>{_xml_escape(domain)}</domainName>
        <name>{_xml_escape(_WITHDRAWAL_TEMPLATE_NAME)}</name>
        <version>{_xml_escape(_WITHDRAWAL_TEMPLATE_VERSION)}</version>
      </consentTemplateKey>
      <signerIds>
        <idType>{_xml_escape(GICS_SIGNER_ID_TYPE)}</idType>
        <id>{_xml_escape(patient_id)}</id>
        <orderNumber>1</orderNumber>
      </signerIds>
    </gics:refuseConsent>
  </soapenv:Body>
</soapenv:Envelope>"""


def _envelope_get_policy_states(patient_id: str, domain: str) -> str:
    """
    Build the SOAP XML for getPolicyStatesForPolicyNameAndSignerIds (gICS 2.x).

    Fixed 2026-08-12 — this previously built getCurrentPolicyStatesForPersonAndTemplate,
    which does not exist in this gICS version's WSDL at all (confirmed via a
    live SOAP fault: "Message part ...getCurrentPolicyStatesForPersonAndTemplate
    was not recognized. Does it exist in service WSDL?", HTTP 500). Every
    status query has been silently failing since before this fix — masked
    everywhere except research_routes.py's sync job, the only caller using
    get_consent_status_detailed()'s ok=False signal instead of swallowing the
    failure into an indistinguishable plain "UNKNOWN" string.

    getPolicyStatesForPolicyNameAndSignerIds takes domainName + policyName
    (a plain string, no version — unlike consentTemplateKey) + signerIds +
    useAliases. Verified against a live gICS instance: a patient with an
    accepted consent returns <signedPolicies><status>ACCEPTED</status>...
    a patient who has never consented returns HTTP 200 with an empty
    <return/> — no fault, no signedPolicies element at all (see
    get_consent_status_detailed()'s handling of that case below).
    """
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
    xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
    xmlns:gics="{NS_CONSENT_OPS}">
  <soapenv:Header/>
  <soapenv:Body>
    <gics:getPolicyStatesForPolicyNameAndSignerIds>
      <domainName>{_xml_escape(domain)}</domainName>
      <policyName>{_xml_escape(_POLICY_NAME)}</policyName>
      <signerIds>
        <idType>{_xml_escape(GICS_SIGNER_ID_TYPE)}</idType>
        <id>{_xml_escape(patient_id)}</id>
        <orderNumber>1</orderNumber>
      </signerIds>
      <useAliases>false</useAliases>
    </gics:getPolicyStatesForPolicyNameAndSignerIds>
  </soapenv:Body>
</soapenv:Envelope>"""


def _envelope_list_current_templates(domain: str) -> str:
    """
    Build the SOAP XML for listCurrentConsentTemplates (gICS 2.x).

    Added 2026-08-12 for get_current_template() — lets the mobile app show
    the live, gICS-authored consent document (title/header/footer/module
    text) instead of app-hardcoded copy. Read-only; unrelated to
    addConsent/revokeConsent/getPolicyStatesForPolicyNameAndSignerIds above.
    """
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
    xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
    xmlns:gics="{NS_CONSENT_OPS}">
  <soapenv:Header/>
  <soapenv:Body>
    <gics:listCurrentConsentTemplates>
      <domainName>{_xml_escape(domain)}</domainName>
    </gics:listCurrentConsentTemplates>
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


def _local_name(tag: str) -> str:
    """Strip the namespace prefix from an ElementTree tag, e.g. '{ns}foo' -> 'foo'."""
    return tag.split("}")[-1] if "}" in tag else tag


def _child(parent: Optional[ET.Element], name: str) -> Optional[ET.Element]:
    """First DIRECT child of *parent* whose local name matches *name* (not recursive —
    needed because e.g. a template and its nested module both have their own <title>,
    and only direct-child lookup can tell them apart)."""
    if parent is None:
        return None
    for el in parent:
        if _local_name(el.tag) == name:
            return el
    return None


def _children(parent: Optional[ET.Element], name: str) -> list[ET.Element]:
    """All DIRECT children of *parent* whose local name matches *name*."""
    if parent is None:
        return []
    return [el for el in parent if _local_name(el.tag) == name]


def _child_text(parent: Optional[ET.Element], name: str) -> str:
    el = _child(parent, name)
    return (el.text or "").strip() if el is not None and el.text else ""


def _deep_html_unescape(value: str, max_passes: int = 4) -> str:
    """
    Repeatedly HTML-entity-decode until stable.

    Some rich-text content authored in gICS's admin UI (e.g. pasted as raw
    HTML source into a code/pre block rather than the visual editor) comes
    back double- or triple-escaped — e.g. "&amp;lt;p&amp;gt;" instead of
    "<p>". A single unescape leaves it still-escaped; this loops until a
    pass makes no further change (capped so malformed input can't spin).
    """
    prev = value
    for _ in range(max_passes):
        nxt = html.unescape(prev)
        if nxt == prev:
            break
        prev = nxt
    return prev


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


def _normalize_signed_status(raw_status: str) -> str:
    """
    Normalise a single gICS <status> value → ACCEPTED | REJECTED | UNKNOWN.

    Renamed from _parse_consent_status() 2026-08-12 — now takes an
    already-extracted status string rather than re-parsing XML, since
    get_consent_status_detailed() has to walk multiple <signedPolicies>
    entries itself to find the current one (see that method's docstring)
    and only needs this for the final normalisation step.

    "REFUSED" added to the REJECTED-equivalent set — it's the literal
    status refuseConsent() (revoke_consent()'s underlying operation as of
    2026-08-12) produces, so a revoked patient must map here the same way
    an explicitly REJECTED one does, not fall through to UNKNOWN.
    """
    if not raw_status:
        return "UNKNOWN"
    upper = raw_status.upper()
    if upper in ("ACCEPTED", "CONSENT"):
        return "ACCEPTED"
    if upper in ("REJECTED", "REVOKED", "DECLINED", "WITHDRAWN", "REFUSED"):
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
        Revoke a patient's consent in gICS by recording a REFUSED
        signed-policy entry (via refuseConsent — see _envelope_revoke_consent()
        for why this replaced the nonexistent revokeConsent operation).

        Verified live 2026-08-12: refuseConsent succeeds (200, no fault)
        even for a signer with no prior consent record at all — unlike the
        old revokeConsent shape, there's no legitimate "not found" fault
        case to tolerate here. Any fault now genuinely means something is
        misconfigured (e.g. an unknown domain/template), so — unlike the
        old code — a fault is no longer swallowed as success; that
        swallowing is exactly what let the broken revokeConsent operation
        go unnoticed for however long it was live.

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
            _log_soap_fault("refuseConsent", patient_id, domain, fault, resp.text)
            return False

        logger.info("gICS consent refused (revoked)  domain=%s  patient=%.20s…", domain, patient_id)
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
            # Fixed 2026-08-12: this used to treat any fault containing
            # "not found" / "unknown" as a genuine "no consent" answer.
            # Verified live against getPolicyStatesForPolicyNameAndSignerIds
            # that a genuine "never consented" patient does NOT come back
            # as a fault at all — it's a clean 200 with an empty <return/>
            # (handled below). A fault from THIS operation now always means
            # something is actually wrong — e.g. an unknown domain or policy
            # name, exactly the class of config mismatch that caused this
            # whole investigation — so it must not be swallowed as ok=True
            # anymore; doing so would have hidden today's bug as "patient
            # hasn't consented" instead of surfacing it as an error.
            _log_soap_fault("getPolicyStatesForPolicyNameAndSignerIds", patient_id, template_id, fault, resp.text)
            return {"status": "UNKNOWN", "ok": False, "error": fault}

        if "<signedPolicies" not in resp.text:
            # A fault-free 200 with an empty <return/> — verified live
            # against gICS as exactly what a patient who has never
            # consented gets back from this operation. This is gICS's
            # genuine answer, not a failed or malformed response.
            logger.debug(
                "gICS get_consent_status: no signed policy for patient "
                "%.20s… in domain %s (empty return — never consented)",
                patient_id, template_id,
            )
            return {"status": "UNKNOWN", "ok": True, "error": None}

        # Fixed 2026-08-12: gICS returns the FULL signed-policy history for
        # this signer+policy, not just the current state — verified live
        # that refuseConsent (the operation revoke_consent() now uses)
        # APPENDS a new entry rather than replacing the prior one. Picking
        # the first <status> tag in document order (the old approach, via
        # _parse_consent_status()) was a latent bug: it happened to read
        # correctly only for a patient with exactly one signed-policy
        # record ever. A patient who accepted then revoked would still
        # read back as ACCEPTED, since that entry appears first. Instead,
        # parse every <signedPolicies> entry and take the one with the
        # latest <consentKey><consentDate> — the genuinely current status.
        try:
            root = ET.fromstring(resp.text)
        except ET.ParseError as exc:
            logger.error("gICS get_consent_status: XML parse error: %s", exc)
            return {"status": "UNKNOWN", "ok": False, "error": f"unparseable gICS response: {exc}"}

        return_el = next((el for el in root.iter() if _local_name(el.tag) == "return"), None)
        signed_policies = _children(return_el, "signedPolicies")

        # Fixed 2026-08-12, same day — the tie-breaking below used to require
        # a STRICTLY later consentDate to replace the current pick. Verified
        # live that consentDate only carries second-level precision, and an
        # accept immediately followed by a revoke (the exact accept-then-
        # revoke test this whole fix exists for) can land both records in
        # the same second — a real, reproduced case, not a hypothetical
        # edge case. A strict ">" meant a same-second revoke lost the tie to
        # the earlier accept and status read back as ACCEPTED right after a
        # successful revoke. Now uses ">=": among entries with the same
        # timestamp, gICS returns them in creation order (observed
        # consistently in every test today), so preferring whichever is
        # later IN THE LIST on an exact tie means the more recent action
        # wins — matches every case we've actually seen.
        latest_status: Optional[str] = None
        latest_dt: Optional[datetime] = None
        for sp_el in signed_policies:
            status_text = _child_text(sp_el, "status")
            if not status_text:
                continue
            date_text = _child_text(_child(sp_el, "consentKey"), "consentDate")
            dt: Optional[datetime] = None
            if date_text:
                try:
                    dt = datetime.fromisoformat(date_text.replace("Z", "+00:00"))
                except ValueError:
                    dt = None
            # A record with no parseable date can't be safely ordered — only
            # let it win if nothing else has been picked yet.
            if latest_status is None or (dt is not None and (latest_dt is None or dt >= latest_dt)):
                latest_status = status_text
                latest_dt = dt if dt is not None else latest_dt

        if latest_status is None:
            # signedPolicies WAS present (unlike the empty-return case
            # above) but no entry had a parseable <status> — this is
            # genuinely an unexpected response shape, not gICS telling us
            # "no consent." Treat it as a failed query so a distinguishing
            # caller doesn't read it as a real answer.
            logger.warning(
                "gICS get_consent_status: signedPolicies present but no "
                "status tag for patient %.20s… in domain %s — treating as "
                "a failed query, not a genuine UNKNOWN",
                patient_id, template_id,
            )
            return {"status": "UNKNOWN", "ok": False, "error": "no status tag inside signedPolicies"}

        status = _normalize_signed_status(latest_status)
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

    def get_current_template(self, domain: str = GICS_DOMAIN) -> Optional[dict]:
        """
        Fetch the currently active consent template for *domain* — title,
        header, footer, and each assigned module's label/title/text — so
        the mobile app can display the authoritative, gICS-authored
        consent document instead of app-hardcoded copy.

        Added 2026-08-12 for the "View full consent document" feature.
        Display-only and read-only: never called by accept_consent() or
        revoke_consent_strict(), so a failure here can never block granting
        or revoking consent — those keep working exactly as before,
        independent of whether this call succeeds.

        A domain can have multiple current templates; this filters to the
        one matching _TEMPLATE_NAME/_TEMPLATE_VERSION — the same template
        add_consent()/get_consent_status_detailed() actually operate
        against — rather than just returning "the first one" from gICS.

        Content fields (title/header/footer/module title/text) are run
        through _deep_html_unescape() — see its docstring for why some of
        this content came back double-escaped from gICS's admin UI.

        Returns
        -------
        {
          "label": str, "title": str (HTML), "header": str (HTML), "footer": str (HTML),
          "modules": [
            {"label": str, "title": str (HTML), "short_text": str, "text": str (HTML), "mandatory": bool},
            ...
          ]
        }
        None if gICS is unreachable, returns a fault, the response doesn't
        parse, or no template matching _TEMPLATE_NAME/_TEMPLATE_VERSION is
        found. Callers should treat None as "document unavailable right
        now" — this is a display-only convenience, not a data integrity
        signal, so there's no need to distinguish the failure reason the
        way get_consent_status_detailed() does for the research sync job.
        """
        payload = _envelope_list_current_templates(domain)
        try:
            resp = requests.post(
                _SOAP_ENDPOINT,
                data=payload.encode("utf-8"),
                headers=_SOAP_HEADERS,
                timeout=GICS_TIMEOUT,
            )
            resp.raise_for_status()
        except requests.RequestException as exc:
            logger.error("gICS get_current_template request failed: %s", exc)
            return None

        fault = _parse_soap_fault(resp.text)
        if fault:
            _log_soap_fault("listCurrentConsentTemplates", "-", domain, fault, resp.text)
            return None

        try:
            root = ET.fromstring(resp.text)
        except ET.ParseError as exc:
            logger.error("gICS get_current_template: XML parse error: %s", exc)
            return None

        return_el = next((el for el in root.iter() if _local_name(el.tag) == "return"), None)
        if return_el is None:
            return None

        for template_el in _children(return_el, "currentConsentTemplates"):
            key_el = _child(template_el, "key")
            name = _child_text(key_el, "name")
            version = _child_text(key_el, "version")
            if name != _TEMPLATE_NAME or version != _TEMPLATE_VERSION:
                continue  # a different template in this domain — not the one this app submits consent against

            modules = []
            for am_el in _children(template_el, "assignedModules"):
                module_el = _child(am_el, "module")
                if module_el is None:
                    continue
                modules.append({
                    "label":      _child_text(module_el, "label"),
                    "title":      _deep_html_unescape(_child_text(module_el, "title")),
                    "short_text": _child_text(module_el, "shortText"),
                    "text":       _deep_html_unescape(_child_text(module_el, "text")),
                    "mandatory":  _child_text(am_el, "mandatory").lower() == "true",
                })

            return {
                "label":   _child_text(template_el, "label"),
                "title":   _deep_html_unescape(_child_text(template_el, "title")),
                "header":  _deep_html_unescape(_child_text(template_el, "header")),
                "footer":  _deep_html_unescape(_child_text(template_el, "footer")),
                "modules": modules,
            }

        logger.warning(
            "gICS get_current_template: no current template named %r v%s found in domain %s",
            _TEMPLATE_NAME, _TEMPLATE_VERSION, domain,
        )
        return None

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