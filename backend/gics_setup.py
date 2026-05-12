"""
gics_setup.py
─────────────────────────────────────────────────────────────────────────────
One-shot initialisation script: creates the Policy, Module, and Template
that gICS requires before it can record any consents for the
"morafek-data-sharing" domain.

ROOT CAUSE (why addPolicy returned 500 in the previous run)
-----------------------------------------------------------
gICS exposes TWO separate SOAP services:

  gicsService            → consent operations  (addConsent, revokeConsent …)
  gicsManagementService  → admin operations    (addPolicy, addModule,
                                                addConsentTemplate, …)

The previous script called addPolicy on gicsService, which does not expose
that operation — hence the 500 "was not recognized" fault.

This script sends all management calls to the correct endpoint and namespace:
  Endpoint:   http://localhost:8082/gics/gicsManagementService
  Namespace:  http://management.consent.ttp.ganimed.icmvc.emau.org/

Run ONCE after `docker compose up -d` (when gICS has fully booted):

    python gics_setup.py

Safe to re-run — every call is idempotent (DuplicateEntryException = OK).

Environment variables (optional, defaults match docker-compose.yml)
--------------------------------------------------------------------
GICS_URL             base URL  (default: http://localhost:8082)
GICS_DOMAIN          domain    (default: morafek-data-sharing)
GICS_SIGNER_ID_TYPE  id type   (default: morafek-patient-id)
"""

from __future__ import annotations

import os
import sys
import time
import xml.etree.ElementTree as ET

import requests

# ─── Config ────────────────────────────────────────────────────────────────────

GICS_BASE   = os.environ.get("GICS_URL", "http://localhost:8082").rstrip("/")
DOMAIN      = os.environ.get("GICS_DOMAIN", "morafek-data-sharing")
ID_TYPE     = os.environ.get("GICS_SIGNER_ID_TYPE", "morafek-patient-id")
TIMEOUT     = 15

CONSENT_EP    = f"{GICS_BASE}/gics/gicsService"
MANAGEMENT_EP = f"{GICS_BASE}/gics/gicsManagementService"

NS_CONSENT    = "http://consent.ttp.ganimed.icmvc.emau.org/"
NS_MANAGEMENT = "http://management.consent.ttp.ganimed.icmvc.emau.org/"

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


def _post(endpoint: str, body: str, label: str) -> str:
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
                print(f"  !  {label} -- SOAP fault: {msg}")
                return r.text

    if r.status_code >= 400:
        print(f"  X {label} -- HTTP {r.status_code}: {r.text[:400]}", file=sys.stderr)
        sys.exit(1)

    print(f"  OK {label}")
    return r.text


# ─── Management operations (all on gicsManagementService) ──────────────────────

def add_policy() -> None:
    body = f"""<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
    xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
    xmlns:mgmt="{NS_MANAGEMENT}">
  <soapenv:Header/>
  <soapenv:Body>
    <mgmt:addPolicy>
      <policy>
        <domainName>{_esc(DOMAIN)}</domainName>
        <name>{_esc(POLICY_NAME)}</name>
        <version>{_esc(POLICY_VERSION)}</version>
        <label>Data Sharing Policy</label>
        <comment>Allows pseudonymised data to be used for research.</comment>
        <expirationProperties>
          <calculationBase>CONSENT_DATE</calculationBase>
          <period><value>0</value><type>WITHOUT_EXPIRATION</type></period>
        </expirationProperties>
      </policy>
    </mgmt:addPolicy>
  </soapenv:Body>
</soapenv:Envelope>"""
    _post(MANAGEMENT_EP, body, "addPolicy")


def add_module() -> None:
    body = f"""<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
    xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
    xmlns:mgmt="{NS_MANAGEMENT}">
  <soapenv:Header/>
  <soapenv:Body>
    <mgmt:addModule>
      <module>
        <domainName>{_esc(DOMAIN)}</domainName>
        <name>{_esc(MODULE_NAME)}</name>
        <version>{_esc(MODULE_VERSION)}</version>
        <label>Data Sharing Module</label>
        <comment>Bundles the data-sharing policy.</comment>
        <assignedPolicies>
          <assignedPolicy>
            <policy>
              <domainName>{_esc(DOMAIN)}</domainName>
              <name>{_esc(POLICY_NAME)}</name>
              <version>{_esc(POLICY_VERSION)}</version>
            </policy>
            <displayCheckboxes>true</displayCheckboxes>
            <mandatory>true</mandatory>
            <orderNumber>1</orderNumber>
          </assignedPolicy>
        </assignedPolicies>
      </module>
    </mgmt:addModule>
  </soapenv:Body>
</soapenv:Envelope>"""
    _post(MANAGEMENT_EP, body, "addModule")


def add_template() -> None:
    """
    The template name/version MUST match _POLICY_NAME/_POLICY_VERSION
    in gics_service.py ("data-sharing" / "1.0").
    """
    body = f"""<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
    xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
    xmlns:mgmt="{NS_MANAGEMENT}">
  <soapenv:Header/>
  <soapenv:Body>
    <mgmt:addConsentTemplate>
      <consentTemplate>
        <domainName>{_esc(DOMAIN)}</domainName>
        <name>{_esc(TEMPLATE_NAME)}</name>
        <version>{_esc(TEMPLATE_VERSION)}</version>
        <label>Morafek CareMate -- Data Sharing Consent</label>
        <comment>Informed consent for pseudonymised research data sharing.</comment>
        <type>CONSENT</type>
        <assignedModules>
          <assignedModule>
            <module>
              <domainName>{_esc(DOMAIN)}</domainName>
              <name>{_esc(MODULE_NAME)}</name>
              <version>{_esc(MODULE_VERSION)}</version>
            </module>
            <mandatory>true</mandatory>
            <displayCheckboxes>true</displayCheckboxes>
            <orderNumber>1</orderNumber>
          </assignedModule>
        </assignedModules>
        <signerIdTypes>
          <signerIdType>
            <domainName>{_esc(DOMAIN)}</domainName>
            <name>{_esc(ID_TYPE)}</name>
          </signerIdType>
        </signerIdTypes>
        <expirationProperties>
          <calculationBase>CONSENT_DATE</calculationBase>
          <period><value>0</value><type>WITHOUT_EXPIRATION</type></period>
        </expirationProperties>
      </consentTemplate>
    </mgmt:addConsentTemplate>
  </soapenv:Body>
</soapenv:Envelope>"""
    _post(MANAGEMENT_EP, body, "addConsentTemplate")


def smoke_test() -> None:
    """
    Test addConsent on the regular gicsService to confirm the template is
    now recognised.  Uses a dummy patient ID you can remove afterwards via
    the gICS admin UI: Signers -> Search -> 'setup-smoke-test'.
    """
    from datetime import datetime, timezone
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    pid = "setup-smoke-test"
    body = f"""<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
    xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
    xmlns:gics="{NS_CONSENT}">
  <soapenv:Header/>
  <soapenv:Body>
    <gics:addConsent>
      <consent>
        <signerIds>
          <signerId>
            <idType>{_esc(ID_TYPE)}</idType>
            <id>{_esc(pid)}</id>
            <orderNumber>1</orderNumber>
            <isDisplayId>true</isDisplayId>
          </signerId>
        </signerIds>
        <consentTemplateKey>
          <domainName>{_esc(DOMAIN)}</domainName>
          <name>{_esc(TEMPLATE_NAME)}</name>
          <version>{_esc(TEMPLATE_VERSION)}</version>
        </consentTemplateKey>
        <consentDates>
          <legalConsentDate>{now_iso}</legalConsentDate>
        </consentDates>
        <scans/>
        <signatureIsFromGuardian>false</signatureIsFromGuardian>
      </consent>
    </gics:addConsent>
  </soapenv:Body>
</soapenv:Envelope>"""
    print("\nSmoke-test: calling addConsent on gicsService ...")
    _post(CONSENT_EP, body, f"addConsent (patient={pid})")


def wait_for_gics(retries: int = 24, delay: int = 5) -> None:
    url = f"{MANAGEMENT_EP}?wsdl"
    print(f"Waiting for gICS management WSDL at {url} ...")
    for i in range(retries):
        try:
            r = requests.get(url, timeout=5)
            if r.status_code == 200 and "wsdl" in r.text.lower():
                print(f"  OK gICS management service is up (attempt {i + 1})")
                return
        except requests.RequestException:
            pass
        print(f"  ... not ready, retrying in {delay}s (attempt {i + 1}/{retries})")
        time.sleep(delay)
    print("  X gICS management service did not become ready in time", file=sys.stderr)
    sys.exit(1)


# ─── Main ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print(f"\n{'=' * 64}")
    print(f"gICS setup  |  domain: {DOMAIN}")
    print(f"Management: {MANAGEMENT_EP}")
    print(f"Consent:    {CONSENT_EP}")
    print(f"{'=' * 64}\n")

    wait_for_gics()

    print("\n[1/3] addPolicy ...")
    add_policy()

    print("[2/3] addModule ...")
    add_module()

    print("[3/3] addConsentTemplate ...")
    add_template()

    smoke_test()

    print(f"\n{'=' * 64}")
    print("Setup complete.")
    print("Verify: http://localhost:8082/gics-web/ -> Templates -> 1 record")
    print("Clean up: Signers -> Search -> delete 'setup-smoke-test'")
    print(f"{'=' * 64}\n")