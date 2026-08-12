"""
gics_setup_nodomain.py
─────────────────────────────────────────────────────────────────────────────
⚠️ STALE as of 2026-08-12 — targets an OLDER domain/template/module/policy
naming scheme ("morafek-data-sharing" / "morafek-patient-id" / "data-sharing"
/ "data-sharing-module") that no longer matches what's actually running.
The live domain today is "Morafek" (signer-ID type "IMI"), with a
"ENRICH Consent Policy" (enrich_consent_policy) / "wearable_health_data_recording"
module / two templates (Consent + Withdrawal) — all created BY HAND through
gICS's admin UI, not by this script. Running this script as-is will not
reproduce the current setup and may create a second, disconnected policy
tree under the old names.

For the current, verified-working setup procedure — including the exact
admin-UI steps, the two Label-vs-Key and HTML-double-escaping gotchas this
script's own JAXB fix history hints at, and how to verify each value with a
live SOAP call before trusting it — see
docs/documentation/03-research-admin-consent.md §10 "First-Time gICS Setup".
This script is left in place for its documented fix history (still accurate
technical detail about gICS 2025.2.x's SOAP envelope quirks) and as a
starting point if the SOAP-based setup approach is ever revived, not as a
runnable up-to-date setup path.

Like gics_setup.py but skips addDomain entirely.
Use this when the domain was already created via the gICS web UI.

Run:
    python gics_setup_nodomain.py

Fully idempotent — teardown() deletes any existing policy/module/template
before recreating them, so re-runs always produce a clean state.

Fix history
-----------
Fix B  — Wrong namespace (gICS 1.x → cm2 namespace)
Fix C  — signerIdTypes as plain text
Fix D  — domainName/name/version wrapped in <key>
Fix E  — expirationProperties removed from policy/module/template DTOs
Fix F  — isDisplayId removed from SignerIdDTO
Fix H  — addModule: removed <assignedPolicy> wrapper
Fix I  — addConsentTemplate: removed <assignedModule> wrapper
Fix J  — addConsent: added <consentDate> inside <key>
Fix K  — addModule / addConsentTemplate: added <finaliseRelatedEntities>true
Fix L  — teardown(): delete template → module → policy before each run
Fix M  — wait_for_gics EJB probe: check for "Envelope" (no angle-bracket or
         prefix) instead of "<Envelope". gICS responses use namespace-prefixed
         tags (<ns0:Envelope …>) so "<Envelope" never matched, causing the
         probe to loop for the full 30 retries even when the server was ready.
Fix N  — addConsentTemplate: corrected <assignedModules> element order to match
         the JAXB schema (module → mandatory → orderNumber → comment →
         defaultConsentStatus). Wrong order caused EclipseLink to silently null the
         module join-table record → V7 at consent time. Also removed the
         non-schema <displayCheckboxes> field.
Fix O  — smoke_test addConsent: added <moduleStatuses> with status=ACCEPTED.
         Without an explicit status for each template module, gICS V7 validation
         fires ("missing module") even when the module is fully finalised.
Fix P  — Corrected JAXB field ordering across all three DTOs to match the WSDL
         schema (JAXB silently nulls fields that arrive out of sequence):
         • policyDTO:         comment → finalised (REQUIRED) → key → label
         • moduleDTO:         assignedPolicies → comment → finalised (REQUIRED)
                              → key → label → shortText → text → title
         • assignedPolicyDTO: comment → externProperties → policy
         • assignedModuleDTO: defaultConsentStatus → mandatory (REQUIRED)
                              → module → orderNumber (REQUIRED)
         Also added <finalised>false</finalised> to addPolicy and addModule
         payloads — it is a REQUIRED field (no minOccurs="0" in schema) so
         omitting it caused EclipseLink to default the flag to false and ignore
         subsequent finaliseAllForDomain calls for those objects.
Fix Q  — smoke_test addConsent: moduleStates entry now uses MODULE key
         (MODULE_NAME / MODULE_VERSION) instead of POLICY key. The V7 validator
         iterates the template's assignedModules and looks up each module key
         in this map; using the policy key caused "missing module".
Fix T  — smoke_test addConsent: added <signature> element with a `type` XML
         attribute to satisfy the mandatory signer group validation on CONSENT-type
         templates. signatureDTO WSDL field order: identifier → signatureBase64 →
         signingDate → signingPlace. <patientSigningDate> added after
         patientSignatureIsFromGuardian in JAXB field order.
         1. moduleStates <value> must be a moduleStateDTO, NOT a plain string.
            WSDL: moduleStateDTO = consentState (ConsentStatus) → key (moduleKeyDTO)
            → policyKeys (optional). Sending <value>ACCEPTED</value> was parsed
            as an empty/null DTO → "no consent status set for module".
            Correct: <value><consentState>ACCEPTED</consentState><key>…</key></value>
         2. consentLightDTO field order (JAXB alphabetical extension):
            • <legacyTypeMapping/> is a REQUIRED field (no minOccurs="0") that
              must appear between <key> and <moduleStates>. Its absence caused
              JAXB to mis-align the following fields.
            • <scans/> belongs to consentDTO (derived class), not consentLightDTO
              (base class). JAXB serialises base-class fields first, then derived
              fields. So <scans/> must appear AFTER <patientSignatureIsFromGuardian>
              (a consentLightDTO field), not before it.
            • <metaData/> is also a REQUIRED consentDTO field; added as empty elem.
Fix U  — smoke_test addConsent: corrected <signature type="…"> attribute value.
         Fix T used type="participants_or_guardians" (the SignatureTypeGroup.id),
         but gICS's validator does NOT check the group id directly. It iterates
         mandatory groups and for each group G collects the set of SignatureType.id
         values whose SignatureType.group IDREF points to G, then checks whether
         the consent contains at least one <signature> whose `type` attribute is
         in that set. The group id only appears in the error message; it is never
         a valid type value. The correct value is a SignatureType.id configured in
         the domain's signature-config for the participant signer (gICS 2.x default:
         "participant"). Exposed as the GICS_SIGNER_TYPE_PARTICIPANT env-var.
         If the smoke-test still fails after this fix, run dump_domain_signature_types()
         (added below wait_for_gics) to print all SignatureType ids found in the
         live domain config, then update GICS_SIGNER_TYPE_PARTICIPANT accordingly.
Fix V  — smoke_test addConsent: added a second <signature> element for the
         physician mandatory group. The gICS web UI shows "Signature Physician
         (required)" as a separate mandatory signer group alongside "Participant
         or guardian". gICS's validator iterates ALL mandatory groups, so the
         consent must satisfy every group — not just the participant group.
         Without the physician signature the validator fires a "signature group"
         fault which, until this fix, was mis-attributed to a wrong participant
         type id. A new SIGNER_TYPE_PHYSICIAN constant / GICS_SIGNER_TYPE_PHYSICIAN
         env-var (default: "physician") controls the SignatureType.id used.
Fix W  — addConsentTemplate: three additional fields required inside
         <assignedModules> for the module's checkboxes to render in the consent
         form UI:
           <displayCheckboxes>ACCEPTED</displayCheckboxes>
           <displayCheckboxes>DECLINED</displayCheckboxes>
           <displayCheckboxes>NOT_ASKED</displayCheckboxes>
         Without these, gICS renders an empty solid-bordered box and fires
         "all mandatory fields must have a consent status".
         Also corrected from working export: mandatory=false, orderNumber=0.
         defaultConsentStatus changed from UNKNOWN to NOT_ASKED — UNKNOWN maps
         to "--None--" preselection which prevents checkboxes from rendering.
         NOT_ASKED is a valid pre-selected status that still requires an explicit
         ACCEPTED/DECLINED choice before the consent can be saved.
"""

from __future__ import annotations

import os
import sys
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

import requests

# ─── Config ────────────────────────────────────────────────────────────────────

GICS_BASE = os.environ.get("GICS_URL", "http://localhost:8082").rstrip("/")
DOMAIN    = os.environ.get("GICS_DOMAIN",         "morafek-data-sharing")
ID_TYPE   = os.environ.get("GICS_SIGNER_ID_TYPE", "morafek-patient-id")
TIMEOUT   = 15

# Fix U: SignatureType.id for the participant signer within the mandatory signer
# group. This is NOT the group id ("participants_or_guardians") but the id of an
# individual SignatureType element whose `group` IDREF points to that group.
# The gICS 2.x web-UI default is "participant". Override via the env-var, or run
# dump_domain_signature_types() to discover the exact ids in your live domain.
SIGNER_TYPE_PARTICIPANT = os.environ.get("GICS_SIGNER_TYPE_PARTICIPANT", "participant")

# Fix V: SignatureType.id for the physician signer within the mandatory physician
# group.  The gICS web UI shows "Signature Physician (required)" — a second
# mandatory group that the smoke test must satisfy alongside the participant group.
# gICS 2.x default physician type id: "physician".
# Override via the env-var, or check Admin → Domains → <domain> → Signature Config.
SIGNER_TYPE_PHYSICIAN = os.environ.get("GICS_SIGNER_TYPE_PHYSICIAN", "physician")

CONSENT_EP    = f"{GICS_BASE}/gics/gicsService"
MANAGEMENT_EP = f"{GICS_BASE}/gics/gicsManagementService"

NS = "http://cm2.ttp.ganimed.icmvc.emau.org/"

POLICY_NAME      = "data-sharing"
POLICY_VERSION   = "1.0"
MODULE_NAME      = "data-sharing-module"
MODULE_VERSION   = "1.0"
TEMPLATE_NAME    = "data-sharing"
TEMPLATE_VERSION = "1.0"

HEADERS = {"Content-Type": "text/xml; charset=utf-8", "SOAPAction": ""}


# ─── Helpers ───────────────────────────────────────────────────────────────────

def _esc(v: str) -> str:
    return (v.replace("&", "&amp;").replace("<", "&lt;")
             .replace(">", "&gt;").replace('"', "&quot;").replace("'", "&apos;"))


def _post(endpoint: str, body: str, label: str, fatal: bool = True) -> str:
    try:
        r = requests.post(endpoint, data=body.encode(), headers=HEADERS, timeout=TIMEOUT)
    except requests.RequestException as exc:
        print(f"  X {label} -- connection error: {exc}", file=sys.stderr)
        sys.exit(1)

    if "<faultstring>" in r.text or "<faultcode>" in r.text:
        root = ET.fromstring(r.text)
        for elem in root.iter():
            local = elem.tag.split("}")[-1] if "}" in elem.tag else elem.tag
            if local in ("faultstring", "message") and elem.text:
                msg = elem.text.strip()
                if "duplicate" in msg.lower() or "already exist" in msg.lower():
                    print(f"  i  {label} -- already exists (idempotent, continuing)")
                    return r.text
                if not fatal:
                    return r.text
                print(f"  !  {label} -- SOAP fault: {msg}")
                return r.text

    if r.status_code >= 400 and fatal:
        print(f"  X {label} -- HTTP {r.status_code}: {r.text[:400]}", file=sys.stderr)
        sys.exit(1)

    print(f"  OK {label}")
    return r.text


def _fault_msg(xml_text: str) -> str | None:
    try:
        root = ET.fromstring(xml_text)
        for elem in root.iter():
            local = elem.tag.split("}")[-1] if "}" in elem.tag else elem.tag
            if local == "faultstring" and elem.text:
                return elem.text.strip()
    except ET.ParseError:
        pass
    return None


# ─── WSDL diagnostic ───────────────────────────────────────────────────────────

def wsdl_probe() -> None:
    """
    Fetch and print the consentDTO / moduleStates schema from the consent
    service WSDL so we can see the exact expected XML structure.
    """
    import re

    url = f"{CONSENT_EP}?wsdl"
    print(f"\n[DIAG] Fetching consent WSDL: {url}")
    try:
        r = requests.get(url, timeout=10)
        r.raise_for_status()
    except requests.RequestException as exc:
        print(f"  X WSDL fetch failed: {exc}")
        return

    wsdl = r.text

    # ── 1. Dump every xs:element or xs:complexType block that mentions moduleStates ──
    print("\n── moduleStates occurrences ──────────────────────────────────────")
    for m in re.finditer(r'.{0,400}moduleStates.{0,400}', wsdl, re.DOTALL):
        snippet = m.group(0).strip()
        print(snippet)
        print("·" * 60)

    # ── 2. Dump the full consentDTO complexType ───────────────────────────────
    print("\n── consentDTO complexType ────────────────────────────────────────")
    m = re.search(
        r'<xs:complexType\s+name="consentDTO".*?</xs:complexType>',
        wsdl, re.DOTALL
    )
    if m:
        print(m.group(0))
    else:
        idx = wsdl.find("consentDTO")
        if idx != -1:
            print(wsdl[max(0, idx - 100):idx + 2000])
        else:
            print("  (consentDTO not found in WSDL)")

    # ── 3. Also dump the map entry type if it has a name ─────────────────────
    for pat in [r'"mapEntry"', r'"entry"', r'MapEntry', r'ConsentModuleDTO']:
        m2 = re.search(
            rf'<xs:complexType\s+name={pat}.*?</xs:complexType>',
            wsdl, re.DOTALL
        )
        if m2:
            print(f"\n── {pat} complexType ──")
            print(m2.group(0))

    print("── end WSDL diagnostic ───────────────────────────────────────────\n")


def wait_for_gics(retries: int = 30, delay: int = 5) -> None:
    """
    Two-phase readiness probe.

    Phase 1 — WSDL fetch returns HTTP 200.
    Phase 2 — A real SOAP call gets any parseable SOAP response (200 or 500).

    Fix M: check for the string "Envelope" (no angle-bracket, no namespace
    prefix) because gICS wraps responses as <ns0:Envelope …> not <Envelope>.
    The previous check "<Envelope" never matched, causing a 150-second wait
    on every run even when gICS was fully ready.

    We use isModuleInUse with a dummy key as the EJB probe because:
    - It IS present in the Management WSDL (getAllDomains is NOT).
    - A dummy domain returns UnknownDomainException — still a valid SOAP
      response meaning the EJB stack is live.
    """
    url = f"{MANAGEMENT_EP}?wsdl"
    print(f"Waiting for gICS at {url} ...")
    for i in range(retries):
        try:
            r = requests.get(url, timeout=5)
            if r.status_code == 200 and "wsdl" in r.text.lower():
                print(f"  OK WSDL up (attempt {i + 1}) — probing EJB layer ...")
                break
        except requests.RequestException:
            pass
        print(f"  ... not ready, retry {i + 1}/{retries} in {delay}s")
        time.sleep(delay)
    else:
        print("  X gICS did not become ready in time", file=sys.stderr)
        sys.exit(1)

    probe = f"""<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:mgmt="{NS}">
  <soapenv:Header/>
  <soapenv:Body>
    <mgmt:isModuleInUse>
      <moduleKey>
        <domainName>__probe__</domainName>
        <name>__probe__</name>
        <version>0.0</version>
      </moduleKey>
    </mgmt:isModuleInUse>
  </soapenv:Body>
</soapenv:Envelope>"""

    for i in range(retries):
        try:
            r = requests.post(MANAGEMENT_EP, data=probe.encode(),
                              headers=HEADERS, timeout=5)
            # Fix M: "Envelope" matches both <Envelope and <ns0:Envelope
            if r.status_code in (200, 500) and "Envelope" in r.text:
                print(f"  OK EJB layer ready (attempt {i + 1})")
                return
        except requests.RequestException as exc:
            print(f"  ... probe failed: {exc}, retry in {delay}s")
        print(f"  ... EJBs not ready, retry {i + 1}/{retries} in {delay}s")
        time.sleep(delay)

    print("  X gICS EJB layer did not become ready", file=sys.stderr)
    sys.exit(1)


# ─── Fix U: Signature-type diagnostics ────────────────────────────────────────

def dump_domain_signature_types() -> None:
    """Print every SignatureType id and its parent group from the live domain config.

    gICS stores the domain's signature-config as XML inside the domainDTO.  The
    management service has no read operation, but the consent service exposes
    getAllConsentsForDomain (and related) while the *management* WSDL itself
    embeds the full type schema.  The easiest probe is to call the management
    service's updateDomain with the *current* data — but we cannot read it first.

    Instead, we fetch the consent-service WSDL which re-exports the config schema,
    then do a raw SOAP call to getConsentTemplateOrNull (or similar) to trigger a
    response that embeds the domain DTO.  If that is not available in this version,
    we fall back to printing guidance for the gICS web UI.

    In practice the fastest route is the gICS REST API (available in 2.13+):
      GET /gics/rest/domains/{domainName}
    which returns the full domainDTO as JSON, including the signatureConfig block.
    """
    print("\n[DIAG] Querying domain signature types ...")

    # ── 1. Try the gICS REST API (2.13+) ──────────────────────────────────────
    for rest_base in (
        f"{GICS_BASE}/gics/rest",
        f"{GICS_BASE}/ths-api/gics/rest",
        f"{GICS_BASE}/gics/gicsManagementService/rest",
    ):
        url = f"{rest_base}/domains/{DOMAIN}"
        try:
            r = requests.get(url, timeout=TIMEOUT)
            if r.status_code == 200:
                _parse_signature_types_from_json(r.text)
                return
        except requests.RequestException:
            pass

    # ── 2. Try fetching the domain config XML via the consent WSDL ────────────
    #    Some gICS versions embed domain info in WSDL annotations; unlikely to
    #    help, but we at least dump the signatureDTO schema lines for reference.
    import re
    try:
        r = requests.get(f"{CONSENT_EP}?wsdl", timeout=TIMEOUT)
        if r.status_code == 200:
            hits = re.findall(r'<xs:attribute\s+name="type"[^/]*/>', r.text)
            if hits:
                print("  Found signatureDTO type attribute in consent WSDL:")
                for h in hits:
                    print(f"    {h}")
    except requests.RequestException:
        pass

    # ── 3. Fallback: manual instructions ──────────────────────────────────────
    print(
        "  Could not query signature types automatically.\n"
        "  To find the correct signature type id values:\n"
        f"    1. Open {GICS_BASE}/gics-web/\n"
        "    2. Navigate to Admin → Domains → morafek-data-sharing → Signature Config\n"
        "    3. For GICS_SIGNER_TYPE_PARTICIPANT:\n"
        "         Expand the 'participants_or_guardians' group\n"
        "         Note the 'id' attribute of each SignatureType (common defaults: 'participant', 'guardian')\n"
        "    4. For GICS_SIGNER_TYPE_PHYSICIAN:\n"
        "         Expand the 'physician' group\n"
        "         Note the 'id' attribute of each SignatureType (common default: 'physician')\n"
        "    5. Re-run with the correct values, e.g.:\n"
        "         GICS_SIGNER_TYPE_PARTICIPANT=participant GICS_SIGNER_TYPE_PHYSICIAN=physician python gics_setup.py\n"
        "       or update the constants at the top of this file."
    )


def _parse_signature_types_from_json(text: str) -> None:
    """Parse and print SignatureType ids from a gICS REST domain response."""
    import json, re
    try:
        data = json.loads(text)
        # The signatureConfig is stored as an XML string in the domain DTO.
        sig_xml = (
            data.get("signatureConfig")
            or data.get("properties", {}).get("signatureConfig")
            or ""
        )
        if isinstance(sig_xml, dict):
            # Some versions return it pre-parsed
            sig_xml = json.dumps(sig_xml)
        if not sig_xml:
            print("  REST response does not contain a signatureConfig field.")
            print(f"  Raw keys: {list(data.keys())}")
            return

        # Extract <type id="…" group="…" …> attributes from the config XML
        types = re.findall(
            r'<type\s[^>]*\bid=["\']([^"\']+)["\'][^>]*\bgroup=["\']([^"\']+)["\']',
            sig_xml,
        )
        if not types:
            # Try the other attribute order
            types = re.findall(
                r'<type\s[^>]*\bgroup=["\']([^"\']+)["\'][^>]*\bid=["\']([^"\']+)["\']',
                sig_xml,
            )
            types = [(b, a) for a, b in types]  # swap to (id, group)

        if types:
            print("  SignatureType ids found in domain config:")
            for tid, gid in types:
                if gid == "participants_or_guardians":
                    marker = " ← use for GICS_SIGNER_TYPE_PARTICIPANT"
                elif gid == "physician":
                    marker = " ← use for GICS_SIGNER_TYPE_PHYSICIAN"
                else:
                    marker = ""
                print(f"    id={tid!r:30s}  group={gid!r}{marker}")
        else:
            print("  Could not parse SignatureType ids from signatureConfig.")
            print(f"  signatureConfig snippet: {sig_xml[:400]}")
    except (json.JSONDecodeError, KeyError) as exc:
        print(f"  Failed to parse REST response: {exc}")
        print(f"  Raw response: {text[:400]}")


# ─── Teardown (Fix L) ──────────────────────────────────────────────────────────

def _delete_template() -> None:
    body = f"""<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:mgmt="{NS}">
  <soapenv:Header/>
  <soapenv:Body>
    <mgmt:deleteConsentTemplate>
      <consentTemplateKey>
        <domainName>{_esc(DOMAIN)}</domainName>
        <name>{_esc(TEMPLATE_NAME)}</name>
        <version>{_esc(TEMPLATE_VERSION)}</version>
      </consentTemplateKey>
    </mgmt:deleteConsentTemplate>
  </soapenv:Body>
</soapenv:Envelope>"""
    resp = _post(MANAGEMENT_EP, body, f"deleteConsentTemplate ({TEMPLATE_NAME})", fatal=False)
    msg = _fault_msg(resp)
    if msg is None:
        pass  # _post already printed OK
    elif "unknown" in msg.lower() or "not found" in msg.lower():
        print(f"  i  deleteConsentTemplate — did not exist, skipping")
    elif "in use" in msg.lower():
        print(f"  X deleteConsentTemplate — template has recorded consents.\n"
              f"     Delete those consents manually before re-running.", file=sys.stderr)
        sys.exit(1)
    else:
        print(f"  !  deleteConsentTemplate — unexpected fault: {msg}")


def _delete_module() -> None:
    body = f"""<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:mgmt="{NS}">
  <soapenv:Header/>
  <soapenv:Body>
    <mgmt:deleteModule>
      <moduleKey>
        <domainName>{_esc(DOMAIN)}</domainName>
        <name>{_esc(MODULE_NAME)}</name>
        <version>{_esc(MODULE_VERSION)}</version>
      </moduleKey>
    </mgmt:deleteModule>
  </soapenv:Body>
</soapenv:Envelope>"""
    resp = _post(MANAGEMENT_EP, body, f"deleteModule ({MODULE_NAME})", fatal=False)
    msg = _fault_msg(resp)
    if msg is None:
        pass  # _post already printed OK
    elif "unknown" in msg.lower() or "not found" in msg.lower():
        print(f"  i  deleteModule — did not exist, skipping")
    elif "in use" in msg.lower():
        print(f"  !  deleteModule — still in use after template delete: {msg}")
    else:
        print(f"  !  deleteModule — unexpected fault: {msg}")


def _delete_policy() -> None:
    body = f"""<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:mgmt="{NS}">
  <soapenv:Header/>
  <soapenv:Body>
    <mgmt:deletePolicy>
      <policyKey>
        <domainName>{_esc(DOMAIN)}</domainName>
        <name>{_esc(POLICY_NAME)}</name>
        <version>{_esc(POLICY_VERSION)}</version>
      </policyKey>
    </mgmt:deletePolicy>
  </soapenv:Body>
</soapenv:Envelope>"""
    resp = _post(MANAGEMENT_EP, body, f"deletePolicy ({POLICY_NAME})", fatal=False)
    msg = _fault_msg(resp)
    if msg is None:
        pass  # _post already printed OK
    elif "unknown" in msg.lower() or "not found" in msg.lower():
        print(f"  i  deletePolicy — did not exist, skipping")
    elif "in use" in msg.lower():
        print(f"  !  deletePolicy — still in use after module delete: {msg}")
    else:
        print(f"  !  deletePolicy — unexpected fault: {msg}")


def teardown() -> None:
    """Delete template → module → policy in dependency order (Fix L)."""
    print("\n[0/4] teardown (removing any existing objects) ...")
    _delete_template()
    _delete_module()
    _delete_policy()


# ─── Setup steps ───────────────────────────────────────────────────────────────

def add_policy() -> None:
    # policyDTO WSDL order: comment → finalised (REQUIRED) → key → label
    body = f"""<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:mgmt="{NS}">
  <soapenv:Header/>
  <soapenv:Body>
    <mgmt:addPolicy>
      <policy>
        <comment>Allows pseudonymised data to be used for research.</comment>
        <finalised>false</finalised>
        <key>
          <domainName>{_esc(DOMAIN)}</domainName>
          <name>{_esc(POLICY_NAME)}</name>
          <version>{_esc(POLICY_VERSION)}</version>
        </key>
        <label>Data Sharing Policy</label>
      </policy>
    </mgmt:addPolicy>
  </soapenv:Body>
</soapenv:Envelope>"""
    _post(MANAGEMENT_EP, body, "addPolicy")


def add_module() -> None:
    """Fix H + Fix K: flat AssignedPolicyDTO, finaliseRelatedEntities=true.

    moduleDTO WSDL order: assignedPolicies → comment → finalised (REQUIRED) → key → label
    assignedPolicyDTO inner order: comment → externProperties → policy
    Inner policyDTO (reference only): finalised (REQUIRED) → key
    """
    body = f"""<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:mgmt="{NS}">
  <soapenv:Header/>
  <soapenv:Body>
    <mgmt:addModule>
      <module>
        <assignedPolicies>
          <policy>
            <finalised>false</finalised>
            <key>
              <domainName>{_esc(DOMAIN)}</domainName>
              <name>{_esc(POLICY_NAME)}</name>
              <version>{_esc(POLICY_VERSION)}</version>
            </key>
          </policy>
        </assignedPolicies>
        <comment>Bundles the data-sharing policy.</comment>
        <finalised>false</finalised>
        <key>
          <domainName>{_esc(DOMAIN)}</domainName>
          <name>{_esc(MODULE_NAME)}</name>
          <version>{_esc(MODULE_VERSION)}</version>
        </key>
        <label>Data Sharing Module</label>
      </module>
      <finaliseRelatedEntities>true</finaliseRelatedEntities>
    </mgmt:addModule>
  </soapenv:Body>
</soapenv:Envelope>"""
    _post(MANAGEMENT_EP, body, "addModule")


def add_template() -> None:
    """Fix I + Fix K + Fix W: flat AssignedModuleDTO, finaliseRelatedEntities=true.

    Fix W: derived from the working gICS export XML. Three additional fields are
    required inside <assignedModules> for the module's checkboxes to render in
    the consent form UI:

      <displayCheckboxes>ACCEPTED</displayCheckboxes>
      <displayCheckboxes>DECLINED</displayCheckboxes>
      <displayCheckboxes>NOT_ASKED</displayCheckboxes>

    Without these, gICS has no answer options to display and renders an empty
    solid-bordered box — causing "all mandatory fields must have a consent status".

    Also corrected from the export:
      • mandatory   → false  (working template uses false; true hid the module)
      • orderNumber → 0      (working template uses 0, not 1)
      • defaultConsentStatus → NOT_ASKED (UNKNOWN maps to "--None--" preselection
        which prevents checkboxes from rendering; NOT_ASKED is a valid pre-selected
        status that still requires an explicit ACCEPTED/DECLINED choice on save)

    assignedModuleDTO WSDL order (alphabetical, JAXB):
      comment → defaultConsentStatus → displayCheckboxes (repeated)
      → mandatory → module → orderNumber
    """
    body = f"""<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:mgmt="{NS}">
  <soapenv:Header/>
  <soapenv:Body>
    <mgmt:addConsentTemplate>
      <consentTemplate>
        <key>
          <domainName>{_esc(DOMAIN)}</domainName>
          <name>{_esc(TEMPLATE_NAME)}</name>
          <version>{_esc(TEMPLATE_VERSION)}</version>
        </key>
        <type>CONSENT</type>
        <title>Morafek CareMate -- Data Sharing Consent</title>
        <label>Morafek CareMate -- Data Sharing Consent</label>
        <comment>Informed consent for pseudonymised research data sharing.</comment>
        <assignedModules>
          <defaultConsentStatus>NOT_ASKED</defaultConsentStatus>
          <displayCheckboxes>ACCEPTED</displayCheckboxes>
          <displayCheckboxes>DECLINED</displayCheckboxes>
          <displayCheckboxes>NOT_ASKED</displayCheckboxes>
          <mandatory>false</mandatory>
          <module>
            <key>
              <domainName>{_esc(DOMAIN)}</domainName>
              <name>{_esc(MODULE_NAME)}</name>
              <version>{_esc(MODULE_VERSION)}</version>
            </key>
          </module>
          <orderNumber>0</orderNumber>
        </assignedModules>
      </consentTemplate>
      <finaliseRelatedEntities>true</finaliseRelatedEntities>
    </mgmt:addConsentTemplate>
  </soapenv:Body>
</soapenv:Envelope>"""
    _post(MANAGEMENT_EP, body, "addConsentTemplate")


def finalise_all() -> None:
    body = f"""<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:mgmt="{NS}">
  <soapenv:Header/>
  <soapenv:Body>
    <mgmt:finaliseAllForDomain>
      <domainName>{_esc(DOMAIN)}</domainName>
    </mgmt:finaliseAllForDomain>
  </soapenv:Body>
</soapenv:Envelope>"""
    _post(MANAGEMENT_EP, body, f"finaliseAllForDomain ({DOMAIN})")


def smoke_test() -> None:
    """Fix F+J+N+Q+R+S+U+V: full consentDTO with correct field ordering and value types.

    Fix Q: moduleStates key uses the MODULE key (data-sharing-module).
    Fix R: <entry> wrapper required inside <moduleStates>.
    Fix S: two WSDL-proven corrections:
      1. <value> must be moduleStateDTO: <consentState>ACCEPTED</consentState>
         plus the <key> (moduleKeyDTO) repeated inside the value DTO.
         Sending plain <value>ACCEPTED</value> gives a null/empty DTO object
         → "no consent status set for module".
      2. Field order follows JAXB extension rules (base fields first, then derived):
         consentLightDTO fields: consentDates → key → legacyTypeMapping (REQUIRED)
           → moduleStates (REQUIRED) → patientSignatureIsFromGuardian (REQUIRED)
         consentDTO fields (after all base fields): metaData (REQUIRED) → scans
    Fix U: <signature type="…"> uses SIGNER_TYPE_PARTICIPANT ("participant" by
         default), a SignatureType.id within the mandatory group — not the group
         id itself.  See dump_domain_signature_types() if the value is unknown.
    Fix V: second <signature> element added for the physician mandatory group.
    """
    result = _post(CONSENT_EP, _build_smoke_body(), "addConsent (patient=setup-smoke-test)", fatal=False)
    if _fault_msg(result) is None:
        print("  OK addConsent (patient=setup-smoke-test)")


def _build_smoke_body(pid: str = "setup-smoke-test") -> str:
    """Return the addConsent SOAP envelope for the smoke-test patient."""
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:gics="{NS}">
  <soapenv:Header/>
  <soapenv:Body>
    <gics:addConsent>
      <consent>
        <!-- consentLightDTO fields (base class — must come first) -->
        <consentDates>
          <legalConsentDate>{now_iso}</legalConsentDate>
        </consentDates>
        <key>
          <consentTemplateKey>
            <domainName>{_esc(DOMAIN)}</domainName>
            <name>{_esc(TEMPLATE_NAME)}</name>
            <version>{_esc(TEMPLATE_VERSION)}</version>
          </consentTemplateKey>
          <consentDate>{now_iso}</consentDate>
          <signerIds>
            <idType>{_esc(ID_TYPE)}</idType>
            <id>{_esc(pid)}</id>
            <orderNumber>1</orderNumber>
          </signerIds>
        </key>
        <legacyTypeMapping/>
        <moduleStates>
          <entry>
            <key>
              <domainName>{_esc(DOMAIN)}</domainName>
              <name>{_esc(MODULE_NAME)}</name>
              <version>{_esc(MODULE_VERSION)}</version>
            </key>
            <value>
              <consentState>ACCEPTED</consentState>
              <key>
                <domainName>{_esc(DOMAIN)}</domainName>
                <name>{_esc(MODULE_NAME)}</name>
                <version>{_esc(MODULE_VERSION)}</version>
              </key>
            </value>
          </entry>
        </moduleStates>
        <patientSignatureIsFromGuardian>false</patientSignatureIsFromGuardian>
        <patientSigningDate>{now_iso}</patientSigningDate>
        <!-- Fix U: type="…" must be a SignatureType.id within the mandatory group,
             NOT the group id ("participants_or_guardians") itself.
             gICS validates: for each mandatory group G, check that at least one
             consent <signature> has type == SignatureType.id where that type's
             `group` IDREF == G.id.  The group id only appears in the error message.
             gICS 2.x default participant type id: "participant".
             Override via GICS_SIGNER_TYPE_PARTICIPANT env-var or the constant above.
             signatureDTO field order: identifier → signatureBase64 → signingDate
             → signingPlace (all optional). -->
        <signature type="{_esc(SIGNER_TYPE_PARTICIPANT)}">
          <signatureBase64>dGVzdA==</signatureBase64>
          <signingDate>{now_iso}</signingDate>
        </signature>
        <!-- Fix V: The template has a second mandatory signature group for the
             physician ("Signature Physician (required)" in the gICS web UI).
             gICS iterates ALL mandatory groups and the consent must satisfy every
             one of them.  Without this element the validator fires a "signature
             group" fault even when the participant signature is perfectly correct.
             signatureDTO field order is the same: identifier (optional, 0…∞) →
             signatureBase64 → signingDate → signingPlace.
             gICS 2.x default physician type id: "physician".
             Override via GICS_SIGNER_TYPE_PHYSICIAN env-var or the constant above. -->
        <signature type="{_esc(SIGNER_TYPE_PHYSICIAN)}">
          <signatureBase64>dGVzdA==</signatureBase64>
          <signingDate>{now_iso}</signingDate>
        </signature>
        <!-- consentDTO fields (derived class — must come after all base fields) -->
        <metaData/>
        <scans/>
      </consent>
    </gics:addConsent>
  </soapenv:Body>
</soapenv:Envelope>"""


# ─── Main ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print(f"\n{'=' * 64}")
    print(f"gICS setup (domain pre-exists)  |  domain: {DOMAIN}")
    print(f"Management: {MANAGEMENT_EP}")
    print(f"Consent:    {CONSENT_EP}")
    print(f"{'=' * 64}\n")

    wait_for_gics()

    teardown()

    print("\n[1/4] addPolicy ...")
    add_policy()

    print("[2/4] addModule ...")
    add_module()

    print("[3/4] addConsentTemplate ...")
    add_template()

    print("[4/4] finaliseAllForDomain ...")
    finalise_all()

    print(f"\nSmoke-test: addConsent (participant={SIGNER_TYPE_PARTICIPANT!r}, physician={SIGNER_TYPE_PHYSICIAN!r}) ...")
    result = _post(CONSENT_EP, _build_smoke_body(), f"addConsent (patient=setup-smoke-test)", fatal=False)
    fault = _fault_msg(result)
    if fault and "signature" in fault.lower() and "group" in fault.lower():
        print(
            f"\n  Hint: signature group fault — one or both SignatureType.id values may be wrong:\n"
            f"    SIGNER_TYPE_PARTICIPANT = {SIGNER_TYPE_PARTICIPANT!r}\n"
            f"    SIGNER_TYPE_PHYSICIAN   = {SIGNER_TYPE_PHYSICIAN!r}\n"
            "  Running signature type diagnostic ..."
        )
        dump_domain_signature_types()
        print(
            "\n  Re-run after correcting the type ids, e.g.:\n"
            "    GICS_SIGNER_TYPE_PARTICIPANT=participant GICS_SIGNER_TYPE_PHYSICIAN=physician python gics_setup.py\n"
            "  or update the SIGNER_TYPE_PARTICIPANT / SIGNER_TYPE_PHYSICIAN constants at the top of this file."
        )
    elif fault is None:
        print("  OK addConsent (patient=setup-smoke-test)")

    print(f"\n{'=' * 64}")
    print("Setup complete.")
    print("Verify:    http://localhost:8082/gics-web/ -> Templates -> 1 record")
    print("Clean up:  Signers -> Search -> delete 'setup-smoke-test'")
    print(f"{'=' * 64}\n")