import requests

xml = """<?xml version="1.0"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:g="http://cm2.ttp.ganimed.icmvc.emau.org/">
  <soapenv:Header/>
  <soapenv:Body>
    <g:getAllConsentsForDomain>
      <domainName>morafek-data-sharing</domainName>
    </g:getAllConsentsForDomain>
  </soapenv:Body>
</soapenv:Envelope>"""

r = requests.post(
    "http://localhost:8082/gics/gicsService",
    headers={"Content-Type": "text/xml"},
    data=xml.encode()
)

print("Status:", r.status_code)
print("Response:")
print(r.text)