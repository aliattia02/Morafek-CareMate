# gics_inspect.ps1 — inspect gICS state using correct operation names
$mgmt_ep    = "http://localhost:8082/gics/gicsManagementService"
$headers    = @{ "Content-Type" = "text/xml; charset=utf-8"; "SOAPAction" = "" }
$domain     = "morafek-data-sharing"

function Invoke-SOAP($label, $ep, $body) {
    try {
        $r = Invoke-WebRequest -Uri $ep -Method POST -Body $body -Headers $headers -UseBasicParsing
        Write-Host "`n=== $label ===`n$($r.Content)"
    } catch {
        Write-Host "`n=== $label === ERROR: $_"
    }
}

# 1. Is domain finalised?
Invoke-SOAP "isDomainInUse" $mgmt_ep @"
<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:mgmt="http://cm2.ttp.ganimed.icmvc.emau.org/">
  <soapenv:Header/>
  <soapenv:Body>
    <mgmt:isDomainInUse>
      <domainName>$domain</domainName>
    </mgmt:isDomainInUse>
  </soapenv:Body>
</soapenv:Envelope>
"@

# 2. Is module finalised?
Invoke-SOAP "isModuleInUse" $mgmt_ep @"
<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:mgmt="http://cm2.ttp.ganimed.icmvc.emau.org/">
  <soapenv:Header/>
  <soapenv:Body>
    <mgmt:isModuleInUse>
      <moduleKey>
        <domainName>$domain</domainName>
        <name>data-sharing-module</name>
        <version>1.0</version>
      </moduleKey>
    </mgmt:isModuleInUse>
  </soapenv:Body>
</soapenv:Envelope>
"@

# 3. Is policy finalised?
Invoke-SOAP "isPolicyInUse" $mgmt_ep @"
<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:mgmt="http://cm2.ttp.ganimed.icmvc.emau.org/">
  <soapenv:Header/>
  <soapenv:Body>
    <mgmt:isPolicyInUse>
      <policyKey>
        <domainName>$domain</domainName>
        <name>data-sharing</name>
        <version>1.0</version>
      </policyKey>
    </mgmt:isPolicyInUse>
  </soapenv:Body>
</soapenv:Envelope>
"@

# 4. Is template finalised?
Invoke-SOAP "isConsentTemplateInUse" $mgmt_ep @"
<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:mgmt="http://cm2.ttp.ganimed.icmvc.emau.org/">
  <soapenv:Header/>
  <soapenv:Body>
    <mgmt:isConsentTemplateInUse>
      <consentTemplateKey>
        <domainName>$domain</domainName>
        <name>data-sharing</name>
        <version>1.0</version>
      </consentTemplateKey>
    </mgmt:isConsentTemplateInUse>
  </soapenv:Body>
</soapenv:Envelope>
"@

# 5. Which modules are finalised in the domain?
Invoke-SOAP "filterModulesInUse" $mgmt_ep @"
<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:mgmt="http://cm2.ttp.ganimed.icmvc.emau.org/">
  <soapenv:Header/>
  <soapenv:Body>
    <mgmt:filterModulesInUse>
      <domainName>$domain</domainName>
    </mgmt:filterModulesInUse>
  </soapenv:Body>
</soapenv:Envelope>
"@

# 6. Which templates are finalised in the domain?
Invoke-SOAP "filterConsentTemplatesInUse" $mgmt_ep @"
<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:mgmt="http://cm2.ttp.ganimed.icmvc.emau.org/">
  <soapenv:Header/>
  <soapenv:Body>
    <mgmt:filterConsentTemplatesInUse>
      <domainName>$domain</domainName>
    </mgmt:filterConsentTemplatesInUse>
  </soapenv:Body>
</soapenv:Envelope>
"@