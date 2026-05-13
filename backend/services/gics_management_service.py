"""
GICS Management Service Client
Generated from: gics_management_clean.wsdl
Endpoint: http://localhost:8082/gics/gicsManagementService
Namespace: http://cm2.ttp.ganimed.icmvc.emau.org/

Covers all 33 operations of the GICSManagementService SOAP API.
Uses the `requests` library (no Zeep dependency required).

Fix K — _assigned_module_xml: use key-only module ref to prevent V7 "missing module"
  Previously _assigned_module_xml called _module_xml() for the inner <module>
  element. _module_xml() always emits <finalised>false</finalised> (via the
  `module.get('finalised', False)` default). EclipseLink persists that flag into
  the template's join table, and the V7 consent validator sees finalised=false on
  the joined module record → "missing module" at addConsent time.
  Fix: a new _module_key_ref_xml() helper emits only <key>; _assigned_module_xml
  uses it instead of _module_xml() for the inner <module> reference.

Fix R — _module_states_xml: added helper that correctly wraps each moduleStates
  map entry in <entry>. JAXB error "unexpected element 'key', expected <{}entry>"
  confirmed the standard XmlJavaTypeAdapter is used for consentDTO.moduleStates.
  Correct wire format: <moduleStates><entry><key>…</key><value>…</value></entry>
  </moduleStates>. Direct <key>/<value> children of <moduleStates> (no <entry>
  wrapper) cause an Unmarshalling Error and the consent is rejected.
"""

import requests
import logging
from datetime import datetime
from typing import Optional
from xml.etree import ElementTree as ET

logger = logging.getLogger(__name__)

# ── Namespace constants ────────────────────────────────────────────────────────
SOAP_ENV = "http://schemas.xmlsoap.org/soap/envelope/"
TNS      = "http://cm2.ttp.ganimed.icmvc.emau.org/"

# ── Exceptions ─────────────────────────────────────────────────────────────────
class GICSError(Exception):
    """Raised when GICS returns a SOAP fault or an unexpected response."""
    def __init__(self, message: str, fault_code: str = "", fault_detail: str = ""):
        super().__init__(message)
        self.fault_code   = fault_code
        self.fault_detail = fault_detail

    def __str__(self):
        parts = [super().__str__()]
        if self.fault_code:
            parts.append(f"Code: {self.fault_code}")
        if self.fault_detail:
            parts.append(f"Detail: {self.fault_detail}")
        return " | ".join(parts)


# ── Low-level SOAP helpers ──────────────────────────────────────────────────────
def _soap_envelope(body_xml: str) -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        f'<soapenv:Envelope xmlns:soapenv="{SOAP_ENV}" xmlns:tns="{TNS}">'
        "<soapenv:Header/>"
        f"<soapenv:Body>{body_xml}</soapenv:Body>"
        "</soapenv:Envelope>"
    )


def _opt(tag: str, value) -> str:
    """Wrap a value in an XML tag; returns empty string when value is None."""
    if value is None:
        return ""
    return f"<{tag}>{value}</{tag}>"


def _bool(value: bool) -> str:
    return "true" if value else "false"


def _dt(value: datetime) -> str:
    return value.strftime("%Y-%m-%dT%H:%M:%S")


# ── DTO serialisers ─────────────────────────────────────────────────────────────
def _policy_key_xml(domain_name: str, name: str, version: str) -> str:
    return (
        f"{_opt('domainName', domain_name)}"
        f"{_opt('name', name)}"
        f"{_opt('version', version)}"
    )


def _module_key_xml(domain_name: str, name: str, version: str) -> str:
    return (
        f"{_opt('domainName', domain_name)}"
        f"{_opt('name', name)}"
        f"{_opt('version', version)}"
    )


def _template_key_xml(domain_name: str, name: str, version: str) -> str:
    return (
        f"{_opt('domainName', domain_name)}"
        f"{_opt('name', name)}"
        f"{_opt('version', version)}"
    )


def _expiration_xml(
    tag: str,
    valid_period: Optional[str] = None,
    fixed_expiration_date: Optional[datetime] = None,
) -> str:
    if valid_period is None and fixed_expiration_date is None:
        return ""
    inner = (
        f"{_opt('validPeriod', valid_period)}"
        f"{_opt('fixedExpirationDate', _dt(fixed_expiration_date) if fixed_expiration_date else None)}"
    )
    return f"<{tag}>{inner}</{tag}>"


def _domain_xml(domain: dict) -> str:
    """Serialise a domainDTO dict to XML."""
    signers = "".join(f"<signerIdTypes>{s}</signerIdTypes>" for s in domain.get("signerIdTypes", []))
    exp = _expiration_xml(
        "expirationProperties",
        domain.get("validPeriod"),
        domain.get("fixedExpirationDate"),
    )
    return (
        f"{_opt('name', domain.get('name'))}"
        f"{_opt('label', domain.get('label'))}"
        f"{_opt('logo', domain.get('logo'))}"
        f"{_opt('comment', domain.get('comment'))}"
        f"{_opt('externProperties', domain.get('externProperties'))}"
        f"{_opt('ctVersionConverter', domain.get('ctVersionConverter'))}"
        f"{_opt('moduleVersionConverter', domain.get('moduleVersionConverter'))}"
        f"{_opt('policyVersionConverter', domain.get('policyVersionConverter'))}"
        f"<finalised>{_bool(domain.get('finalised', False))}</finalised>"
        f"{signers}"
        f"{exp}"
    )


def _policy_xml(policy: dict) -> str:
    """Serialise a policyDTO dict to XML.

    WSDL field order (alphabetical per JAXB):
      comment → externProperties → finalised (REQUIRED) → key → label
    """
    key = policy.get("key", {})
    key_xml = ""
    if key:
        key_xml = (
            f"<key>{_policy_key_xml(key.get('domainName'), key.get('name'), key.get('version'))}</key>"
        )
    return (
        f"{_opt('comment', policy.get('comment'))}"
        f"{_opt('externProperties', policy.get('externProperties'))}"
        f"<finalised>{_bool(policy.get('finalised', False))}</finalised>"
        f"{key_xml}"
        f"{_opt('label', policy.get('label'))}"
    )


def _module_xml(module: dict) -> str:
    """
    Serialise a full moduleDTO dict to XML.

    NOTE: do NOT use this for the <module> reference inside <assignedModules>
    on a consent template — it emits <finalised>false</finalised> which poisons
    the template's module join record and causes V7 "missing module" at consent
    time. Use _module_key_ref_xml() for that context instead.
    """
    key = module.get("key", {})
    key_xml = ""
    if key:
        key_xml = (
            f"<key>{_module_key_xml(key.get('domainName'), key.get('name'), key.get('version'))}</key>"
        )
    # assignedPolicyDTO inner order (WSDL): comment → externProperties → policy
    policies_xml = ""
    for ap in module.get("assignedPolicies", []):
        p = ap.get("policy", {})
        policies_xml += (
            f"<assignedPolicies>"
            f"{_opt('comment', ap.get('comment'))}"
            f"{_opt('externProperties', ap.get('externProperties'))}"
            f"<policy>{_policy_xml(p)}</policy>"
            f"</assignedPolicies>"
        )
    # moduleDTO WSDL order: assignedPolicies -> comment -> externProperties ->
    #   finalised (REQUIRED) -> key -> label -> shortText -> text -> title
    return (
        f"{policies_xml}"
        f"{_opt('comment', module.get('comment'))}"
        f"{_opt('externProperties', module.get('externProperties'))}"
        f"<finalised>{_bool(module.get('finalised', False))}</finalised>"
        f"{key_xml}"
        f"{_opt('label', module.get('label'))}"
        f"{_opt('shortText', module.get('shortText'))}"
        f"{_opt('text', module.get('text'))}"
        f"{_opt('title', module.get('title'))}"
    )


def _module_key_ref_xml(module: dict) -> str:
    """
    Key-only module stub — use this when referencing a module INSIDE a
    consent template's <assignedModules> element.

    Fix K: the <module> child of <assignedModules> must contain ONLY <key>.
    Including any other module DTO fields (especially <finalised>false</finalised>)
    causes EclipseLink to persist those values into the template's join table.
    The V7 consent validator then reads finalised=false from that join record
    and reports "missing module" even though the standalone module IS finalised.
    """
    key = module.get("key", {})
    if not key:
        return ""
    return f"<key>{_module_key_xml(key.get('domainName'), key.get('name'), key.get('version'))}</key>"


def _assigned_module_xml(am: dict) -> str:
    """
    Serialise an AssignedModuleDTO for use inside a consent template.

    Fix K: uses _module_key_ref_xml() (key only) instead of _module_xml()
    (full DTO) for the inner <module> element. See _module_key_ref_xml docstring.
    """
    # Key-only reference — never include <finalised> or other DTO fields here.
    mod_xml = _module_key_ref_xml(am.get("module", {})) if am.get("module") else ""
    parent_key = am.get("parent", {})
    parent_xml = ""
    if parent_key:
        parent_xml = (
            f"<parent>{_module_key_xml(parent_key.get('domainName'), parent_key.get('name'), parent_key.get('version'))}</parent>"
        )
    # assignedModuleDTO WSDL order: comment → defaultConsentStatus →
    #   externProperties → mandatory (REQUIRED) → module → orderNumber (REQUIRED) → parent
    return (
        f"<assignedModules>"
        f"{_opt('comment', am.get('comment'))}"
        f"{_opt('defaultConsentStatus', am.get('defaultConsentStatus'))}"
        f"{_opt('externProperties', am.get('externProperties'))}"
        f"<mandatory>{_bool(am.get('mandatory', False))}</mandatory>"
        f"<module>{mod_xml}</module>"
        f"<orderNumber>{am.get('orderNumber', 0)}</orderNumber>"
        f"{parent_xml}"
        f"</assignedModules>"
    )


def _module_states_xml(module_states: list) -> str:
    """
    Serialise the consentDTO.moduleStates map for use in addConsent / updateConsent.

    Fix R + Fix S (WSDL-proven):
      - Each entry is wrapped in <entry> (standard JAXB XmlJavaTypeAdapter).
      - <key>   → moduleKeyDTO  (domainName, name, version)
      - <value> → moduleStateDTO, NOT a plain ConsentStatus string.
        moduleStateDTO fields (WSDL order): consentState → key → policyKeys

    Correct wire format:
        <moduleStates>
          <entry>
            <key><domainName>…</domainName><name>…</name><version>…</version></key>
            <value>
              <consentState>ACCEPTED</consentState>
              <key><domainName>…</domainName><name>…</name><version>…</version></key>
            </value>
          </entry>
        </moduleStates>

    Args:
        module_states: list of dicts, each with:
            domainName (str), name (str), version (str), status (str e.g. "ACCEPTED")
            policyKeys (optional list of {"domainName", "name", "version"} dicts)

    Example:
        _module_states_xml([
            {"domainName": "my-domain", "name": "my-module",
             "version": "1.0", "status": "ACCEPTED"},
        ])
    """
    result = ""
    for entry in module_states:
        domain  = entry.get("domainName", "")
        name    = entry.get("name", "")
        version = entry.get("version", "")
        status  = entry.get("status", "UNKNOWN")
        key_xml = _module_key_xml(domain, name, version)
        policy_keys_xml = "".join(
            f"<policyKeys>{_policy_key_xml(pk.get('domainName'), pk.get('name'), pk.get('version'))}</policyKeys>"
            for pk in entry.get("policyKeys", [])
        )
        result += (
            f"<moduleStates>"
            f"<entry>"
            f"<key>{key_xml}</key>"
            f"<value>"
            f"<consentState>{status}</consentState>"
            f"<key>{key_xml}</key>"
            f"{policy_keys_xml}"
            f"</value>"
            f"</entry>"
            f"</moduleStates>"
        )
    return result


def _consent_template_xml(ct: dict) -> str:
    key = ct.get("key", {})
    key_xml = ""
    if key:
        key_xml = (
            f"<key>{_template_key_xml(key.get('domainName'), key.get('name'), key.get('version'))}</key>"
        )
    modules_xml = "".join(_assigned_module_xml(am) for am in ct.get("assignedModules", []))
    exp = _expiration_xml("expirationProperties", ct.get("validPeriod"), ct.get("fixedExpirationDate"))
    return (
        f"{key_xml}"
        f"{_opt('title', ct.get('title'))}"
        f"{_opt('label', ct.get('label'))}"
        f"{_opt('header', ct.get('header'))}"
        f"{_opt('footer', ct.get('footer'))}"
        f"{_opt('comment', ct.get('comment'))}"
        f"{_opt('externProperties', ct.get('externProperties'))}"
        f"{_opt('type', ct.get('type'))}"
        f"{_opt('versionLabel', ct.get('versionLabel'))}"
        f"{modules_xml}"
        f"{exp}"
    )


# ── Response parsers ────────────────────────────────────────────────────────────
def _parse_response(response_text: str, operation: str) -> ET.Element:
    """Parse SOAP response; raise GICSError on fault."""
    root = ET.fromstring(response_text)
    ns   = {"s": SOAP_ENV}
    body = root.find("s:Body", ns)
    if body is None:
        raise GICSError(f"[{operation}] Empty SOAP body")

    fault = body.find("s:Fault", ns)
    if fault is not None:
        code   = fault.findtext("faultcode")   or ""
        msg    = fault.findtext("faultstring") or "Unknown SOAP fault"
        detail = fault.findtext("detail")      or ""
        raise GICSError(f"[{operation}] {msg}", fault_code=code, fault_detail=detail)

    return body


def _text(element: Optional[ET.Element], path: str, default=None):
    if element is None:
        return default
    el = element.find(path)
    return el.text if el is not None else default


# ── Main client class ──────────────────────────────────────────────────────────
class GICSManagementService:
    """
    Full Python client for the GICS Management SOAP service.

    Usage:
        svc = GICSManagementService("http://localhost:8082/gics/gicsManagementService")

        # Add a domain
        svc.add_domain({"name": "MII", "label": "MII Domain", "finalised": False})

        # Add a policy
        svc.add_policy({"key": {"domainName": "MII", "name": "MDAT_erheben", "version": "1.0"}, "finalised": False})

        # Add a module
        svc.add_module({"key": {"domainName": "MII", "name": "Einwilligung", "version": "1.0"}, ...})

        # Finalise everything for a domain
        svc.finalise_all_for_domain("MII")
    """

    def __init__(self, endpoint: str = "http://localhost:8082/gics/gicsManagementService", timeout: int = 30):
        self.endpoint = endpoint.rstrip("/")
        self.timeout  = timeout
        self.session  = requests.Session()
        self.session.headers.update({
            "Content-Type": "text/xml; charset=utf-8",
            "SOAPAction":   '""',
        })

    def _call(self, operation: str, body_xml: str) -> ET.Element:
        envelope = _soap_envelope(body_xml)
        logger.debug("[GICS] → %s\n%s", operation, envelope)
        resp = self.session.post(self.endpoint, data=envelope.encode("utf-8"), timeout=self.timeout)
        logger.debug("[GICS] ← %s HTTP %s\n%s", operation, resp.status_code, resp.text)
        resp.raise_for_status()
        return _parse_response(resp.text, operation)

    # ── Domain operations ──────────────────────────────────────────────────────

    def add_domain(self, domain: dict) -> None:
        """
        Create a new consent domain.

        domain keys: name, label, logo, comment, externProperties, finalised,
                     signerIdTypes (list[str]), validPeriod, fixedExpirationDate,
                     ctVersionConverter, moduleVersionConverter, policyVersionConverter
        """
        body = f"<tns:addDomain><domain>{_domain_xml(domain)}</domain></tns:addDomain>"
        self._call("addDomain", body)

    def update_domain(self, domain: dict) -> None:
        """Update an existing domain (same keys as add_domain)."""
        body = f"<tns:updateDomain><domain>{_domain_xml(domain)}</domain></tns:updateDomain>"
        self._call("updateDomain", body)

    def update_domain_in_use(self, domain: dict) -> None:
        """Update a finalised (in-use) domain."""
        body = f"<tns:updateDomainInUse><domain>{_domain_xml(domain)}</domain></tns:updateDomainInUse>"
        self._call("updateDomainInUse", body)

    def delete_domain(self, domain_name: str) -> None:
        """Delete a domain by name."""
        body = f"<tns:deleteDomain><domainName>{domain_name}</domainName></tns:deleteDomain>"
        self._call("deleteDomain", body)

    def finalise_domain(self, domain_name: str) -> None:
        """Finalise a domain (makes it active / immutable for structural changes)."""
        body = f"<tns:finaliseDomain><domainName>{domain_name}</domainName></tns:finaliseDomain>"
        self._call("finaliseDomain", body)

    def is_domain_in_use(self, domain_name: str) -> bool:
        """Return True if the domain is finalised and in use."""
        body = f"<tns:isDomainInUse><domainName>{domain_name}</domainName></tns:isDomainInUse>"
        resp = self._call("isDomainInUse", body)
        return _text(resp, ".//{%s}isDomainInUseResponse/return" % TNS) == "true"

    def finalise_all_for_domain(self, domain_name: str) -> None:
        """Finalise all structures (policies, modules, templates) within a domain."""
        body = f"<tns:finaliseAllForDomain><domainName>{domain_name}</domainName></tns:finaliseAllForDomain>"
        self._call("finaliseAllForDomain", body)

    # ── Policy operations ──────────────────────────────────────────────────────

    def add_policy(self, policy: dict) -> None:
        """
        Create a new policy.

        policy keys: key (dict: domainName, name, version), label, comment,
                     externProperties, finalised
        """
        body = f"<tns:addPolicy><policy>{_policy_xml(policy)}</policy></tns:addPolicy>"
        self._call("addPolicy", body)

    def update_policy(self, policy: dict) -> None:
        """Update an existing policy."""
        body = f"<tns:updatePolicy><policy>{_policy_xml(policy)}</policy></tns:updatePolicy>"
        self._call("updatePolicy", body)

    def update_policy_in_use(self, policy: dict) -> None:
        """Update a finalised (in-use) policy."""
        body = f"<tns:updatePolicyInUse><policy>{_policy_xml(policy)}</policy></tns:updatePolicyInUse>"
        self._call("updatePolicyInUse", body)

    def delete_policy(self, domain_name: str, name: str, version: str) -> None:
        """Delete a policy by its key (domainName, name, version)."""
        body = (
            f"<tns:deletePolicy><policyKey>"
            f"{_policy_key_xml(domain_name, name, version)}"
            f"</policyKey></tns:deletePolicy>"
        )
        self._call("deletePolicy", body)

    def finalise_policy(self, domain_name: str, name: str, version: str) -> None:
        """Finalise a policy."""
        body = (
            f"<tns:finalisePolicy><policyKey>"
            f"{_policy_key_xml(domain_name, name, version)}"
            f"</policyKey></tns:finalisePolicy>"
        )
        self._call("finalisePolicy", body)

    def is_policy_in_use(self, domain_name: str, name: str, version: str) -> bool:
        """Return True if the policy is finalised and in use."""
        body = (
            f"<tns:isPolicyInUse><policyKey>"
            f"{_policy_key_xml(domain_name, name, version)}"
            f"</policyKey></tns:isPolicyInUse>"
        )
        resp = self._call("isPolicyInUse", body)
        return _text(resp, ".//{%s}isPolicyInUseResponse/return" % TNS) == "true"

    def filter_policies_in_use(self, domain_name: str) -> list[dict]:
        """Return all finalised policies in a domain."""
        body = f"<tns:filterPoliciesInUse><domainName>{domain_name}</domainName></tns:filterPoliciesInUse>"
        resp = self._call("filterPoliciesInUse", body)
        results = []
        for el in resp.findall(".//{%s}filterPoliciesInUseResponse/return" % TNS):
            key_el = el.find("key")
            results.append({
                "domainName": _text(key_el, "domainName"),
                "name":       _text(key_el, "name"),
                "version":    _text(key_el, "version"),
                "label":      _text(el, "label"),
                "finalised":  _text(el, "finalised") == "true",
            })
        return results

    def process_policy_validity_changes(self, domain_name: str, name: str, version: str) -> None:
        """Trigger validity re-evaluation for a specific policy."""
        body = (
            f"<tns:processPolicyValidityChanges><policyKey>"
            f"{_policy_key_xml(domain_name, name, version)}"
            f"</policyKey></tns:processPolicyValidityChanges>"
        )
        self._call("processPolicyValidityChanges", body)

    def process_policy_validity_changes_for_all_domains(self) -> None:
        """Trigger validity re-evaluation for all policies across all domains."""
        body = "<tns:processPoliciyValidityChangesForAllDomains/>"
        self._call("processPoliciyValidityChangesForAllDomains", body)

    # ── Module operations ──────────────────────────────────────────────────────

    def add_module(self, module: dict, finalise_related_entities: bool = False) -> None:
        """
        Create a new consent module.

        module keys: key (dict: domainName, name, version), title, label,
                     shortText, text, comment, externProperties, finalised,
                     assignedPolicies (list of dicts with 'policy' key)
        """
        body = (
            f"<tns:addModule>"
            f"<module>{_module_xml(module)}</module>"
            f"<finaliseRelatedEntities>{_bool(finalise_related_entities)}</finaliseRelatedEntities>"
            f"</tns:addModule>"
        )
        self._call("addModule", body)

    def update_module(self, module: dict) -> None:
        """Update an existing module."""
        body = f"<tns:updateModule><module>{_module_xml(module)}</module></tns:updateModule>"
        self._call("updateModule", body)

    def update_module_in_use(self, module: dict) -> None:
        """Update a finalised (in-use) module."""
        body = f"<tns:updateModuleInUse><module>{_module_xml(module)}</module></tns:updateModuleInUse>"
        self._call("updateModuleInUse", body)

    def delete_module(self, domain_name: str, name: str, version: str) -> None:
        """Delete a module by its key."""
        body = (
            f"<tns:deleteModule><moduleKey>"
            f"{_module_key_xml(domain_name, name, version)}"
            f"</moduleKey></tns:deleteModule>"
        )
        self._call("deleteModule", body)

    def finalise_module(self, domain_name: str, name: str, version: str) -> None:
        """Finalise a module."""
        body = (
            f"<tns:finaliseModule><moduleKey>"
            f"{_module_key_xml(domain_name, name, version)}"
            f"</moduleKey></tns:finaliseModule>"
        )
        self._call("finaliseModule", body)

    def is_module_in_use(self, domain_name: str, name: str, version: str) -> bool:
        """Return True if the module is finalised and in use."""
        body = (
            f"<tns:isModuleInUse><moduleKey>"
            f"{_module_key_xml(domain_name, name, version)}"
            f"</moduleKey></tns:isModuleInUse>"
        )
        resp = self._call("isModuleInUse", body)
        return _text(resp, ".//{%s}isModuleInUseResponse/return" % TNS) == "true"

    def filter_modules_in_use(self, domain_name: str) -> list[dict]:
        """Return all finalised modules in a domain."""
        body = f"<tns:filterModulesInUse><domainName>{domain_name}</domainName></tns:filterModulesInUse>"
        resp = self._call("filterModulesInUse", body)
        results = []
        for el in resp.findall(".//{%s}filterModulesInUseResponse/return" % TNS):
            key_el = el.find("key")
            results.append({
                "domainName": _text(key_el, "domainName"),
                "name":       _text(key_el, "name"),
                "version":    _text(key_el, "version"),
                "title":      _text(el, "title"),
                "finalised":  _text(el, "finalised") == "true",
            })
        return results

    # ── Consent Template operations ────────────────────────────────────────────

    def add_consent_template(self, consent_template: dict, finalise_related_entities: bool = False) -> None:
        """
        Create a new consent template.

        consent_template keys: key (dict: domainName, name, version), title, label,
                               header, footer, comment, externProperties, type,
                               versionLabel, assignedModules (list of assignedModuleDTO dicts),
                               validPeriod, fixedExpirationDate

        assignedModuleDTO dict keys: module (dict with 'key' sub-dict), mandatory,
                                     orderNumber, comment, externProperties,
                                     defaultConsentStatus, parent (dict with key fields)

        Note: the 'module' dict inside each assignedModules entry should contain
        only a 'key' sub-dict. Do not set 'finalised' on it — see _module_key_ref_xml.
        """
        body = (
            f"<tns:addConsentTemplate>"
            f"<consentTemplate>{_consent_template_xml(consent_template)}</consentTemplate>"
            f"<finaliseRelatedEntities>{_bool(finalise_related_entities)}</finaliseRelatedEntities>"
            f"</tns:addConsentTemplate>"
        )
        self._call("addConsentTemplate", body)

    def update_consent_template(self, consent_template: dict) -> None:
        """Update an existing consent template."""
        body = (
            f"<tns:updateConsentTemplate>"
            f"<consentTemplate>{_consent_template_xml(consent_template)}</consentTemplate>"
            f"</tns:updateConsentTemplate>"
        )
        self._call("updateConsentTemplate", body)

    def update_consent_template_in_use(self, consent_template: dict) -> None:
        """Update a finalised (in-use) consent template."""
        body = (
            f"<tns:updateConsentTemplateInUse>"
            f"<consentTemplate>{_consent_template_xml(consent_template)}</consentTemplate>"
            f"</tns:updateConsentTemplateInUse>"
        )
        self._call("updateConsentTemplateInUse", body)

    def delete_consent_template(self, domain_name: str, name: str, version: str) -> None:
        """Delete a consent template by its key."""
        body = (
            f"<tns:deleteConsentTemplate><consentTemplateKey>"
            f"{_template_key_xml(domain_name, name, version)}"
            f"</consentTemplateKey></tns:deleteConsentTemplate>"
        )
        self._call("deleteConsentTemplate", body)

    def finalise_template(self, domain_name: str, name: str, version: str) -> None:
        """Finalise a consent template."""
        body = (
            f"<tns:finaliseTemplate><consentTemplateKey>"
            f"{_template_key_xml(domain_name, name, version)}"
            f"</consentTemplateKey></tns:finaliseTemplate>"
        )
        self._call("finaliseTemplate", body)

    def is_consent_template_in_use(self, domain_name: str, name: str, version: str) -> bool:
        """Return True if the consent template is finalised and in use."""
        body = (
            f"<tns:isConsentTemplateInUse><consentTemplateKey>"
            f"{_template_key_xml(domain_name, name, version)}"
            f"</consentTemplateKey></tns:isConsentTemplateInUse>"
        )
        resp = self._call("isConsentTemplateInUse", body)
        return _text(resp, ".//{%s}isConsentTemplateInUseResponse/return" % TNS) == "true"

    def filter_consent_templates_in_use(self, domain_name: str) -> list[dict]:
        """Return all finalised consent templates in a domain."""
        body = (
            f"<tns:filterConsentTemplatesInUse>"
            f"<domainName>{domain_name}</domainName>"
            f"</tns:filterConsentTemplatesInUse>"
        )
        resp = self._call("filterConsentTemplatesInUse", body)
        results = []
        for el in resp.findall(".//{%s}filterConsentTemplatesInUseResponse/return" % TNS):
            key_el = el.find("key")
            results.append({
                "domainName": _text(key_el, "domainName"),
                "name":       _text(key_el, "name"),
                "version":    _text(key_el, "version"),
                "title":      _text(el, "title"),
                "type":       _text(el, "type"),
                "finalised":  _text(el, "finalised") == "true",
            })
        return results

    # ── SignerIdType operations ────────────────────────────────────────────────

    def add_signer_id_type(self, domain_name: str, signer_id_type_name: str) -> None:
        """Add a signer ID type to a domain (e.g. 'pseudonym', 'MPI_PID')."""
        body = (
            f"<tns:addSignerIdType>"
            f"<domainName>{domain_name}</domainName>"
            f"<signerIdTypeName>{signer_id_type_name}</signerIdTypeName>"
            f"</tns:addSignerIdType>"
        )
        self._call("addSignerIdType", body)

    def update_signer_id_type(self, domain_name: str, signer_id_type: dict) -> None:
        """
        Update a signer ID type.

        signer_id_type keys: name, label, comment
        """
        body = (
            f"<tns:updateSignerIdType>"
            f"<domainName>{domain_name}</domainName>"
            f"<signerIdType>"
            f"{_opt('name', signer_id_type.get('name'))}"
            f"{_opt('label', signer_id_type.get('label'))}"
            f"{_opt('comment', signer_id_type.get('comment'))}"
            f"</signerIdType>"
            f"</tns:updateSignerIdType>"
        )
        self._call("updateSignerIdType", body)

    def delete_signer_id_type(self, domain_name: str, signer_id_type_name: str) -> None:
        """Delete a signer ID type from a domain."""
        body = (
            f"<tns:deleteSignerIdType>"
            f"<domainName>{domain_name}</domainName>"
            f"<signerIdTypeName>{signer_id_type_name}</signerIdTypeName>"
            f"</tns:deleteSignerIdType>"
        )
        self._call("deleteSignerIdType", body)