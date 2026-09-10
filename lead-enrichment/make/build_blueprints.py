#!/usr/bin/env python3
"""Generate Make.com scenario blueprints for the clinic lead-enrichment pipeline.

Every structural decision here was checked against Make's live API rather than
assumed, because the failure mode is silent: a blueprint with the wrong key
shape imports cleanly and then produces empty cells on every row.

What the API told us, and what it changed:

* ``google-sheets`` v2 names the search module ``filterRows`` (labelled "Search
  Rows"), not ``searchRows``.
* Sheet **filters** address columns by LETTER (``"G"``), while **values** and
  **output references** address them by ZERO-BASED INDEX (``"6"``, ``{{1.6}}``).
  Getting that backwards is the silent failure above.
* ``updateRow`` supports ``mode: "map"``, which takes the spreadsheet id as
  plain text instead of a Drive picker. That is what makes this blueprint
  portable to someone else's account.
* ``builtin:Resume`` takes an empty mapper -- an ``output`` field is rejected.

Two scenarios, not one, because of a hard Make constraint: a filter that fails
stops the whole route for that bundle rather than skipping one module, and
router routes cannot merge back together. A short-circuiting waterfall must
therefore branch, and everything downstream of the branch would have to be
duplicated in every branch. Splitting where the email is resolved keeps each
branch to a single sheet write, and makes the sheet a checkpoint: validation can
be re-run without re-buying email discovery.

The client-facing Delivery and Review tabs are Google Sheets QUERY formulas over
the working sheet, not Make modules. That removes two write operations per row
-- 4,000 operations on a 2,000-row job -- and makes those tabs update live.
"""
from __future__ import annotations

import json
from pathlib import Path

ZONE = "eu1.make.com"
#: Wide enough to cover column AF. Required by the Sheets modules.
TABLE_RANGE = "A1:BZ1"


def col_letter(index: int) -> str:
    """0 -> A, 25 -> Z, 26 -> AA. Sheets filters address columns this way."""
    letters = ""
    n = index
    while True:
        letters = chr(ord("A") + n % 26) + letters
        n = n // 26 - 1
        if n < 0:
            return letters


#: The working "Leads" sheet, in order. It is both the input queue and the audit
#: trail: every provider verdict is written back beside the row it came from.
LEAD_COLUMNS = [
    "row_id", "linkedin_url", "input_name", "input_clinic", "input_domain",
    "input_location", "status",
    "name", "role", "clinic", "domain", "identity_provider",
    "email", "email_provider", "email_source",
    "email_validator", "email_validator_status", "email_validator_sub",
    "email_decision",
    "phone", "phone_type", "phone_source_url", "phone_decision",
    "place_id", "website", "review_reason", "checked_at",
    "delivery_phone", "delivery_email", "delivery_source", "deliverable",
    "review_action",
]
IDX = {name: i for i, name in enumerate(LEAD_COLUMNS)}
LETTER = {name: col_letter(i) for i, name in enumerate(LEAD_COLUMNS)}

#: Reference a column of the row the search module emitted.
def ref(name: str, module: int = 1) -> str:
    return "{{" + f"{module}.{IDX[name]}" + "}}"


#: Same, but bare for use inside a Make formula.
def bare(name: str, module: int = 1) -> str:
    return f"{module}.{IDX[name]}"


ROW_NUMBER = "{{1.__ROW_NUMBER__}}"

#: Shared-mailbox local parts. Both sides are comma-wrapped in the formula so
#: this is an exact token match -- "salesh@" must not read as "sales@".
ROLE_LOCALPARTS = (",info,contact,admin,office,hello,help,support,sales,enquiry,"
                   "enquiries,inquiry,reception,appointments,care,team,mail,"
                   "clinic,frontdesk,billing,accounts,hr,noreply,no-reply,"
                   "webmaster,postmaster,")


# ---------------------------------------------------------------------------
# Module builders
# ---------------------------------------------------------------------------

def designer(x: int, y: int = 0) -> dict:
    return {"designer": {"x": x, "y": y}}


def resume_handler(mid: int, x: int, y: int) -> list:
    """Attached to every HTTP call.

    A provider that is down, rate-limited or returns 404 must never end a
    2,000-row run. Resume swallows the error and lets the bundle continue with
    empty output, which the waterfall filters then read as "this provider had
    nothing" -- the same path as a clean miss.
    """
    return [{
        "id": mid,
        "module": "builtin:Resume",
        "version": 1,
        "parameters": {},
        "mapper": {},
        "metadata": {**designer(x, y), "restore": {}, "expect": []},
    }]


def http_module(mid: int, *, url: str, method: str, x: int, y: int = 0,
                headers: list | None = None, qs: list | None = None,
                body: str | None = None, err_id: int | None = None,
                timeout: int = 40) -> dict:
    """One provider call.

    ``parseResponse`` exposes the JSON body as ``.data`` for downstream mapping.
    ``handleErrors`` routes a 4xx/5xx to the Resume handler instead of letting
    an empty body look like a clean miss.
    """
    mapper = {
        "url": url, "serializeUrl": False, "method": method,
        "headers": headers or [], "qs": qs or [], "parseResponse": True,
        "authUser": "", "authPass": "", "timeout": timeout,
        "shareCookies": False, "ca": "", "rejectUnauthorized": True,
        "followRedirect": True, "useQuerystring": False, "gzip": True,
        "useMtls": False, "followAllRedirects": False,
    }
    if body is not None:
        mapper["bodyType"] = "raw"
        mapper["contentType"] = "application/json"
        mapper["data"] = body

    mod = {
        "id": mid, "module": "http:ActionSendData", "version": 3,
        "parameters": {"handleErrors": True, "useNewZLibDeCompress": True},
        "mapper": mapper,
        "metadata": {**designer(x, y), "restore": {}, "expect": []},
    }
    if err_id is not None:
        mod["onerror"] = resume_handler(err_id, x, y + 150)
    return mod


def set_vars(mid: int, *, variables: list, x: int, y: int = 0) -> dict:
    return {
        "id": mid, "module": "util:SetVariables", "version": 1,
        "parameters": {},
        "mapper": {"scope": "roundtrip", "variables": variables},
        "metadata": {**designer(x, y), "restore": {}, "expect": []},
    }


def sheets_search(mid: int, *, status: str, limit: int, x: int, y: int = 0) -> dict:
    """Search Rows over the working sheet.

    ``includesHeaders`` is false deliberately: with headers off, output fields
    are addressed by stable column index rather than by header text, so renaming
    a header cannot silently break every mapping. The header row is excluded
    naturally -- its status cell reads "status", which no filter matches.
    """
    return {
        "id": mid, "module": "google-sheets:filterRows", "version": 2,
        "parameters": {"__IMTCONN__": None},
        "mapper": {
            "from": "drive",
            "spreadsheetId": "{{SPREADSHEET_ID}}",
            "sheetId": "Leads",
            "includesHeaders": False,
            "tableFirstRow": TABLE_RANGE,
            # Filters address columns by LETTER, unlike values and outputs.
            "filter": [[{"a": LETTER["status"], "b": status, "o": "text:equal"}]],
            "sortOrder": "asc",
            "limit": limit,
            "valueRenderOption": "FORMATTED_VALUE",
            "dateTimeRenderOption": "FORMATTED_STRING",
        },
        "metadata": {**designer(x, y), "restore": {}, "expect": []},
    }


def sheets_update(mid: int, *, values: dict, x: int, y: int = 0) -> dict:
    """Write back to the row we read.

    ``mode: "map"`` takes the spreadsheet id as text, so this blueprint works in
    any account without the author's Drive. Value keys are zero-based column
    indices as strings.
    """
    return {
        "id": mid, "module": "google-sheets:updateRow", "version": 2,
        "parameters": {"__IMTCONN__": None},
        "mapper": {
            "mode": "map",
            "spreadsheetId": "{{SPREADSHEET_ID}}",
            "sheetId": "Leads",
            "rowNumber": ROW_NUMBER,
            "tableFirstRow": TABLE_RANGE,
            "values": {str(IDX[k]): v for k, v in values.items()},
            "valueInputOption": "USER_ENTERED",
        },
        "metadata": {**designer(x, y), "restore": {}, "expect": []},
    }


def router(mid: int, routes: list, x: int, y: int = 0) -> dict:
    return {
        "id": mid, "module": "builtin:BasicRouter", "version": 1,
        "mapper": None, "metadata": designer(x, y), "routes": routes,
    }


def flt(name: str, conditions: list) -> dict:
    return {"name": name, "conditions": conditions}


def has_value(reference: str) -> list:
    return [[{"a": reference, "o": "exist"},
             {"a": reference, "b": "", "o": "text:notequal"}]]


def no_value(reference: str) -> list:
    return [[{"a": reference, "o": "notexist"}],
            [{"a": reference, "b": "", "o": "text:equal"}]]


def scenario(name: str, flow: list) -> dict:
    return {
        "name": name,
        "flow": flow,
        "metadata": {
            "instant": False, "version": 1,
            "scenario": {
                "roundtrips": 1, "maxErrors": 3, "autoCommit": True,
                "autoCommitTriggerLast": True, "sequential": False,
                "slots": None, "confidential": False, "dataloss": False,
                "dlq": False, "freshVariables": False,
            },
            "designer": {"orphans": []}, "zone": ZONE, "notes": [],
        },
    }


# ===========================================================================
#  A note on why every scenario starts by copying the row into variables
#
#  Google Sheets output fields are named by number ("12" is column M), so a
#  direct reference looks like {{1.12}}. That is fine as a whole field value,
#  but inside a formula -- length(1.12) -- it is ambiguous with the decimal
#  literal 1.12, and the failure would be silent. Copying the row into named
#  variables first costs one operation and makes every downstream formula
#  reference something unambiguous like 2.email.
# ===========================================================================

APOLLO = "3.data.person"
PROSPEO_EMAIL = "{{5.data.response.email}}"
FINDYMAIL_EMAIL = "{{8.data.contact.email}}"
HUNTER_EMAIL = "{{11.data.data.email}}"

IDENT_NAME = f'{{{{ifempty(2.name_in; {APOLLO}.name)}}}}'
IDENT_ROLE = f'{{{{ifempty({APOLLO}.title; "")}}}}'
IDENT_CLINIC = f'{{{{ifempty(2.clinic_in; {APOLLO}.organization.name)}}}}'
IDENT_DOMAIN = f'{{{{ifempty(2.domain_in; {APOLLO}.organization.primary_domain)}}}}'


def write_email(mid: int, *, email_ref: str, provider: str, source: str,
                x: int, y: int) -> dict:
    """Every branch of the waterfall ends the same way: one write recording the
    identity, the address, and which provider vouched for it."""
    return sheets_update(mid, x=x, y=y, values={
        "status": "email_done",
        "name": "{{4.name}}",
        "role": "{{4.role}}",
        "clinic": "{{4.clinic}}",
        "domain": "{{4.domain}}",
        "identity_provider": "{{4.identity_provider}}",
        "email": email_ref,
        "email_provider":
            f'{{{{if({email_ref[2:-2]} != emptystring; "{provider}"; "")}}}}',
        "email_source": source,
        "checked_at": '{{formatDate(now; "YYYY-MM-DD HH:mm")}}',
    })


def scenario_one(limit: int = 100) -> dict:
    flow = [
        sheets_search(1, status="pending", limit=limit, x=0),

        # Plain references only -- no formulas around numeric column keys.
        set_vars(2, x=300, variables=[
            {"name": "url", "value": ref("linkedin_url")},
            {"name": "name_in", "value": ref("input_name")},
            {"name": "clinic_in", "value": ref("input_clinic")},
            {"name": "domain_in", "value": ref("input_domain")},
            {"name": "location_in", "value": ref("input_location")},
        ]),

        # ---- identity -----------------------------------------------------
        http_module(
            3, x=600, err_id=30,
            url="https://api.apollo.io/api/v1/people/match", method="post",
            headers=[
                {"name": "x-api-key", "value": "{{APOLLO_API_KEY}}"},
                {"name": "Content-Type", "value": "application/json"},
                {"name": "accept", "value": "application/json"},
            ],
            body=('{"linkedin_url":"{{2.url}}","name":"{{2.name_in}}",'
                  '"organization_name":"{{2.clinic_in}}",'
                  '"domain":"{{2.domain_in}}"}')),

        # Client-supplied values win over the provider: if the client already
        # told us the clinic, a provider disagreeing is a reason to review the
        # row, not to overwrite what they gave us.
        set_vars(4, x=900, variables=[
            {"name": "name", "value": IDENT_NAME},
            {"name": "role", "value": IDENT_ROLE},
            {"name": "clinic", "value": IDENT_CLINIC},
            {"name": "domain", "value": IDENT_DOMAIN},
            {"name": "identity_provider",
             "value": f'{{{{if({APOLLO}.name != emptystring; "apollo"; "sheet_input")}}}}'},
            {"name": "first_name",
             "value": f'{{{{ifempty({APOLLO}.first_name; first(split(ifempty(2.name_in; " "); " ")))}}}}'},
            {"name": "last_name",
             "value": f'{{{{ifempty({APOLLO}.last_name; last(split(ifempty(2.name_in; " "); " ")))}}}}'},
        ]),

        # ---- waterfall step 1: Prospeo takes the LinkedIn URL directly -----
        http_module(
            5, x=1200, err_id=31,
            url="https://api.prospeo.io/linkedin-email-finder", method="post",
            headers=[
                {"name": "X-KEY", "value": "{{PROSPEO_API_KEY}}"},
                {"name": "Content-Type", "value": "application/json"},
            ],
            body='{"url":"{{2.url}}"}'),

        router(6, x=1500, routes=[
            # -- hit: write and stop. Later providers are never called. ------
            {"flow": [dict(
                write_email(7, email_ref=PROSPEO_EMAIL, provider="prospeo",
                            source="{{5.data.response.email_status}}",
                            x=1800, y=-300),
                filter=flt("Prospeo found an address", has_value(PROSPEO_EMAIL)))]},

            # -- miss: step 2, Findymail. It charges only on a hit, so asking
            #    is free when it misses -- which is why it sits second.
            {"flow": [
                dict(http_module(
                    8, x=1800, y=150, err_id=32,
                    url="https://app.findymail.com/api/search/name", method="post",
                    headers=[
                        {"name": "Authorization",
                         "value": "Bearer {{FINDYMAIL_API_KEY}}"},
                        {"name": "Content-Type", "value": "application/json"},
                        {"name": "Accept", "value": "application/json"},
                    ],
                    body='{"name":"{{4.name}}","domain":"{{4.domain}}"}'),
                    filter=flt("Prospeo had nothing", no_value(PROSPEO_EMAIL))),

                router(9, x=2100, y=150, routes=[
                    {"flow": [dict(
                        write_email(10, email_ref=FINDYMAIL_EMAIL,
                                    provider="findymail", source="findymail",
                                    x=2400, y=0),
                        filter=flt("Findymail found an address",
                                   has_value(FINDYMAIL_EMAIL)))]},

                    # -- step 3: Hunter. It returns the public URLs where the
                    #    address was seen, which is the evidence the delivered
                    #    Source column is built from.
                    {"flow": [
                        dict(http_module(
                            11, x=2400, y=300, err_id=33,
                            url="https://api.hunter.io/v2/email-finder",
                            method="get",
                            qs=[
                                {"name": "api_key", "value": "{{HUNTER_API_KEY}}"},
                                {"name": "domain", "value": "{{4.domain}}"},
                                {"name": "first_name", "value": "{{4.first_name}}"},
                                {"name": "last_name", "value": "{{4.last_name}}"},
                                {"name": "max_duration", "value": "10"},
                            ]),
                            filter=flt("Findymail had nothing either",
                                       no_value(FINDYMAIL_EMAIL))),

                        # Last step in the chain, so this write runs whether or
                        # not Hunter found anything. A row nobody could resolve
                        # still leaves the queue with a recorded outcome instead
                        # of silently staying "pending" forever.
                        write_email(12, email_ref=HUNTER_EMAIL, provider="hunter",
                                    source="{{11.data.data.sources[1].uri}}",
                                    x=2700, y=300),
                    ]},
                ]),
            ]},
        ]),
    ]
    return scenario("Clinic Leads · 1 · Identity + Email waterfall", flow)


# ===========================================================================
#  Scenario 2 -- validation gate, published phone, delivery decision
#
#  Linear, no router: the client-facing Delivery and Review tabs are QUERY
#  formulas over this sheet, so Make writes once per row instead of three times.
# ===========================================================================

ZB = "3.data"
PLACES = "6.data"

_ROLE_TEST = (f'contains("{ROLE_LOCALPARTS}"; "," + '
              'lower(first(split(2.email; "@"))) + ",")')

#: Deliverability in the validator's vocabulary, mapped to ours. Anything
#: unrecognised falls to risky_unknown, so the gate fails closed.
_DELIVERABILITY = (
    f'{{{{switch({ZB}.status; "valid"; "deliverable"; "invalid"; "undeliverable"; '
    '"catch-all"; "risky_catch_all"; "unknown"; "risky_unknown"; '
    '"spamtrap"; "do_not_mail"; "abuse"; "do_not_mail"; '
    '"do_not_mail"; "do_not_mail"; "risky_unknown")}}')

#: The gate: deliverable AND a named mailbox. Catch-all and unknown are refused
#: because a domain that accepts every address has told us nothing about this
#: one, and a shared info@ is not the decision-maker's inbox.
_EMAIL_ACCEPTED = (
    f'{{{{if(length(2.email) = 0; false; '
    f'if({_ROLE_TEST}; false; '
    f'if({ZB}.status = "valid"; true; false)))}}}}')

_EMAIL_DECISION = (
    f'{{{{if(length(2.email) = 0; "no_match"; '
    f'if({_ROLE_TEST}; "refused_role_mailbox"; '
    f'if({ZB}.status = "valid"; "accepted"; '
    f'"refused_" + ifempty({ZB}.status; "not_validated"))))}}}}')

_PHONE_RAW = f'ifempty({PLACES}.internationalPhoneNumber; "")'
_PHONE_SRC = f'ifempty({PLACES}.googleMapsUri; "")'

#: The evidence rule: a number ships only with the URL proving the clinic
#: published it. No source, no delivery.
_PHONE_ACCEPTED = (f'{{{{if({_PHONE_RAW} = ""; false; '
                   f'if({_PHONE_SRC} = ""; false; true))}}}}')

_PHONE_TYPE = (
    f'{{{{if({_PHONE_RAW} = ""; ""; '
    f'if(contains("6789"; substring(replace(replace(ifempty({PLACES}'
    '.nationalPhoneNumber; "0"); " "; ""); "-"; ""); 0; 1)); '
    '"business mobile (published)"; "clinic main line (published)"))}}')

_PHONE_DECISION = (
    f'{{{{if({_PHONE_RAW} = ""; "no_published_number"; '
    f'if({_PHONE_SRC} = ""; "withheld_no_evidence"; "published"))}}}}')


def scenario_two(limit: int = 100) -> dict:
    flow = [
        sheets_search(1, status="email_done", limit=limit, x=0),

        set_vars(2, x=300, variables=[
            {"name": "email", "value": ref("email")},
            {"name": "email_provider", "value": ref("email_provider")},
            {"name": "email_source", "value": ref("email_source")},
            {"name": "clinic", "value": ref("clinic")},
            {"name": "location", "value": ref("input_location")},
        ]),

        http_module(
            3, x=600, err_id=40,
            url="https://api.zerobounce.net/v2/validate", method="get",
            qs=[
                {"name": "api_key", "value": "{{ZEROBOUNCE_API_KEY}}"},
                {"name": "email", "value": "{{2.email}}"},
                {"name": "ip_address", "value": ""},
            ]),

        set_vars(4, x=900, variables=[
            {"name": "email_deliverability", "value": _DELIVERABILITY},
            {"name": "email_accepted", "value": _EMAIL_ACCEPTED},
            {"name": "email_decision", "value": _EMAIL_DECISION},
            {"name": "validator_status",
             "value": f'{{{{ifempty({ZB}.status; "not_validated")}}}}'},
            {"name": "validator_sub", "value": f'{{{{ifempty({ZB}.sub_status; "")}}}}'},
        ]),

        # Two Places calls by design: a cheap search picks the right clinic,
        # then a narrow field mask asks only for what the brief needs. Phone and
        # website are Enterprise-SKU fields, so a wider mask silently costs more.
        http_module(
            5, x=1200, err_id=41,
            url="https://places.googleapis.com/v1/places:searchText",
            method="post",
            headers=[
                {"name": "Content-Type", "value": "application/json"},
                {"name": "X-Goog-Api-Key", "value": "{{GOOGLE_MAPS_API_KEY}}"},
                {"name": "X-Goog-FieldMask",
                 "value": "places.id,places.displayName,places.formattedAddress"},
            ],
            body=('{"textQuery":"{{2.clinic}} {{2.location}}",'
                  '"regionCode":"IN","maxResultCount":3}')),

        http_module(
            6, x=1500, err_id=42,
            url="https://places.googleapis.com/v1/places/{{5.data.places[1].id}}",
            method="get",
            headers=[
                {"name": "X-Goog-Api-Key", "value": "{{GOOGLE_MAPS_API_KEY}}"},
                {"name": "X-Goog-FieldMask",
                 "value": ("id,displayName,formattedAddress,"
                           "internationalPhoneNumber,nationalPhoneNumber,"
                           "websiteUri,googleMapsUri")},
            ]),

        set_vars(7, x=1800, variables=[
            {"name": "phone_e164",
             "value": f'{{{{replace(replace({_PHONE_RAW}; " "; ""); "-"; "")}}}}'},
            {"name": "phone_type", "value": _PHONE_TYPE},
            {"name": "phone_source_url", "value": f'{{{{{_PHONE_SRC}}}}}'},
            {"name": "phone_accepted", "value": _PHONE_ACCEPTED},
            {"name": "phone_decision", "value": _PHONE_DECISION},
            {"name": "clinic_website",
             "value": f'{{{{ifempty({PLACES}.websiteUri; "")}}}}'},
        ]),

        # One write. The delivered values are computed here so the client-facing
        # tabs stay plain QUERY formulas over this sheet.
        sheets_update(8, x=2100, values={
            "status": "complete",
            "email_validator": "zerobounce",
            "email_validator_status": "{{4.validator_status}}",
            "email_validator_sub": "{{4.validator_sub}}",
            "email_decision": "{{4.email_decision}}",
            "phone": "{{7.phone_e164}}",
            "phone_type": "{{7.phone_type}}",
            "phone_source_url": "{{7.phone_source_url}}",
            "phone_decision": "{{7.phone_decision}}",
            "place_id": "{{5.data.places[1].id}}",
            "website": "{{7.clinic_website}}",
            "review_reason": ('{{"email: " + 4.email_decision + '
                              '" | phone: " + 7.phone_decision}}'),
            "checked_at": '{{formatDate(now; "YYYY-MM-DD HH:mm")}}',

            # ---- what the client actually receives ----------------------
            "delivery_phone": ('{{if(7.phone_accepted = true; 7.phone_e164 + '
                               '" (" + 7.phone_type + ")"; "")}}'),
            "delivery_email": '{{if(4.email_accepted = true; 2.email; "")}}',
            "delivery_source": (
                '{{if(4.email_accepted = true; "Email: " + 2.email_provider + '
                '" <" + 2.email_source + "> | "; "") + '
                'if(7.phone_accepted = true; "Phone: google_places <" + '
                '7.phone_source_url + ">"; "")}}'),
            "deliverable": ('{{if(4.email_accepted = true; "yes"; '
                            'if(7.phone_accepted = true; "yes"; "no"))}}'),
            "review_action": (
                '{{switch(4.email_decision; '
                '"refused_role_mailbox"; "Shared mailbox, not this person. '
                'Check the clinic site for a named address."; '
                '"refused_catch-all"; "Domain accepts every address, so it proves '
                'nothing. Verify by hand or leave the cell blank."; '
                '"no_match"; "No provider had an address. Add the clinic domain '
                'to the row and re-run."; '
                '"accepted"; "Spot-check against the source URLs."; '
                '"Spot-check against the source URLs.")}}'),
        }),
    ]
    return scenario("Clinic Leads · 2 · Validate, Phone & Deliver", flow)


def main() -> None:
    out = Path(__file__).parent / "blueprints"
    out.mkdir(exist_ok=True)
    for fname, sc in (("01-identity-and-email-waterfall.json", scenario_one()),
                      ("02-validate-phone-and-deliver.json", scenario_two())):
        (out / fname).write_text(json.dumps(sc, indent=2, ensure_ascii=False),
                                 encoding="utf-8")
        print(f"  {fname}  ({len(json.dumps(sc)):,} bytes)")


if __name__ == "__main__":
    main()
