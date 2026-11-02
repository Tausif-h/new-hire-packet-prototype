"""
Check that the app can reach the Anthropic API.

Run:
    python3 check_connection.py

The key comes from ANTHROPIC_API_KEY if set, otherwise from api_key.txt in this folder
(see extract.api_key; line breaks and spaces in the key are removed automatically).
"""
import anthropic

from extract import KEY_FILE, api_key

key = api_key()
if not key:
    print("PROBLEM: no API key found.")
    print(f"Fix: paste the key into {KEY_FILE.name} in this folder, save it, and run this again.")
    raise SystemExit(1)

try:
    anthropic.Anthropic(api_key=key, max_retries=0).models.list()
    print("OK: connected to the API. Start the app with: python3 app.py")
except anthropic.AuthenticationError:
    print(f"PROBLEM: the API rejected the key. Check {KEY_FILE.name} holds the full key from Tiffany's email.")
except anthropic.APIConnectionError as e:
    cause = e.__cause__
    print(f"PROBLEM: could not connect to the API.\nCause: {type(cause).__name__}: {cause}")
    if "CERTIFICATE_VERIFY_FAILED" in str(cause) or "SSL" in type(cause).__name__.upper():
        print("\nThis is the macOS Python certificate issue. Fix:")
        print("    pip3 install certifi")
        print('    export SSL_CERT_FILE="$(python3 -m certifi)"')
        print("then run this check again.")
    else:
        print("\nCheck your internet connection, and turn off any VPN or proxy, then run this again.")
