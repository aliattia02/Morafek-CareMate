"""
Run this in your backend venv:
    python diagnose_mongo_ssl.py

It tests several connection strategies and reports which (if any) work,
so you know exactly what fix to apply.
"""
import ssl
import sys
import os
from dotenv import load_dotenv

load_dotenv()
MONGO_URI = os.environ.get("MONGO_URI", "")

print("=" * 60)
print("Python :", sys.version)
print("OpenSSL:", ssl.OPENSSL_VERSION)
print("URI set:", bool(MONGO_URI))
print("=" * 60)

from pymongo import MongoClient
from pymongo.server_api import ServerApi
import certifi

strategies = [
    ("1. certifi CA bundle (standard fix)",
     dict(tlsCAFile=certifi.where())),

    ("2. tlsAllowInvalidCertificates (diagnose only — NOT for prod)",
     dict(tls=True, tlsAllowInvalidCertificates=True)),

    ("3. ssl_context TLSv1_2 minimum",
     None),  # handled separately below

    ("4. No extra TLS args (bare connection)",
     dict()),
]

def try_connect(label, kwargs):
    print(f"\n{label}")
    try:
        if kwargs is None:
            ctx = ssl.create_default_context()
            ctx.minimum_version = ssl.TLSVersion.TLSv1_2
            client = MongoClient(MONGO_URI, server_api=ServerApi("1"), ssl_context=ctx)
        else:
            client = MongoClient(MONGO_URI, server_api=ServerApi("1"), **kwargs)
        client.admin.command("ping")
        client.close()
        print("  ✅  SUCCESS — this strategy works")
        return True
    except Exception as e:
        short = str(e)[:200]
        print(f"  ❌  FAILED: {short}")
        return False

for label, kwargs in strategies:
    if try_connect(label, kwargs):
        break
else:
    print("\n⚠️  All strategies failed.")
    print("   Most likely causes:")
    print("   • Antivirus/firewall (Kaspersky, Avast, ESET, Windows Defender) intercepting TLS")
    print("   • Corporate/university network proxy doing SSL inspection")
    print("   • Your IP is not on the MongoDB Atlas IP Access List")
    print("\n   Try: temporarily disable antivirus, or switch to mobile hotspot and re-run.")