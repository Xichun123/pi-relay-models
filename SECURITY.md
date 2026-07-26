# Security

## Credentials

This extension never accepts API keys through its AI tool or configuration file.
Enter credentials only through pi's `/login <provider-id>` flow. Pi stores them
in its own credential store.

Never commit `auth.json`, `relay-providers.json`, `.env` files, cookies, bearer
tokens, or private relay URLs containing credentials.

## Reporting a vulnerability

Please report security issues privately through GitHub's security advisory form:

https://github.com/Xichun123/pi-relay-models/security/advisories/new

Do not include production credentials in a report. Revoke any credential that
may have been exposed before sharing diagnostic material.
