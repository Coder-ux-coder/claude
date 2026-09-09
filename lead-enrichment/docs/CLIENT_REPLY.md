# Reply to the job post

The post asks for three things: a line or two on similar work, a small
anonymised sample of 3–5 rows, and your price and timeline.

Below is a draft you can send. **Two rules before you do:**

1. **Fill in the `[…]` yourself.** Those are claims about your own experience.
   Do not let anyone, including me, write them for you.
2. **The sample rows are illustrative format examples, built from this
   repository's fictional demo fixtures.** They are labelled as such, and they
   must stay labelled. Once you have run a real pilot, replace them with three
   genuinely anonymised rows from that pilot — which is a far stronger sample,
   because it is real.

---

## Draft message

> **Subject: 2,000 clinic decision-makers, India — with a source URL behind every field**
>
> Hello,
>
> [*One or two lines on similar work you have actually done — the volume, the
> region, the outcome. If this is your first engagement of this kind, say so and
> lead with the pilot offer below instead; it is a stronger opening than a vague
> claim.*]
>
> **How I would approach yours**
>
> I run a waterfall enrichment pipeline: several data providers in sequence,
> each one only seeing the rows the previous one could not resolve, then a
> validation pass, then a manual review of anything doubtful. Every delivered
> field carries the provider, the source URL and the date it was checked.
>
> Two things I want to be straight about before you choose anyone, because they
> will affect the results whoever you hire:
>
> **1. LinkedIn URLs alone are a weak input now.** Proxycurl, the tool most of
> this industry used to turn a profile URL into structured data, was sued by
> LinkedIn and shut down in July 2025. What remains is matching against
> providers who already hold a record, and some profiles simply will not match.
> If you can send **name and clinic name** alongside each URL, my match rate
> roughly doubles and your cost per usable row drops. If you already have those
> columns, please include them.
>
> **2. On phone numbers.** I deliver business numbers that each clinic has
> itself published — on its Google Business listing or its own website — with
> the source URL and the check date against every one, labelled as either the
> main clinic line or a direct line published for that individual.
>
> I do not supply harvested personal mobiles. Under India's DPDP Act 2023 and
> TRAI's TCCCPR rules, a scraped personal-mobile list is a compliance liability
> for whoever calls it, with penalties up to ₹10 lakh per instance. The
> published clinic line is also, in practice, the number that gets answered
> during working hours. If a verified personal mobile is a hard requirement, I
> am not the right supplier and I would rather say so now than at delivery.
>
> **Sample — format illustration**
>
> *(Fictional records, shown to illustrate the delivery format and the labelling.
> Happy to run a free 25-row pilot on your actual list so you can see real
> output before committing.)*
>
> | Name | Role | Clinic | Phone | Email | Source |
> |---|---|---|---|---|---|
> | Dr Anaya Varma | Founder | Meridian Skin Clinic | +91 99999 10001 (business mobile, published) | anaya.varma@meridianskin.example | Email: hunter <meridianskin.example/team>; Phone: google_places <maps listing> |
> | Rohan Desai | Managing Director | Blue Harbour Dental | +91 99999 10002 (clinic main line, published) | rohan@blueharbourdental.example | Email: findymail; Phone: google_places <maps listing> |
> | Dr Meera Joshi | Proprietor | Lotus Wellness Polyclinic | +91 99999 10005 (direct business line, published) | *withheld — only a shared info@ mailbox was found* | Phone: website <lotuswellness.example/contact> |
>
> Note the third row. A shared `info@` address was found and it is perfectly
> deliverable — but it is not that person's mailbox, so I leave the cell blank
> and tell you why rather than filling it to improve a percentage. You get the
> same treatment for catch-all domains, where a server accepts every address and
> therefore proves nothing.
>
> **Price and timeline**
>
> [*From your own pilot — see docs/OPERATOR_PLAYBOOK.md. Quote in two parts:*]
>
> - Pilot: 100 rows, [₹___], delivered in [__] days. You see real fill rates
>   before committing to the rest.
> - Remaining 1,900: [₹___] per delivered row that clears the quality gate.
>   Rows I cannot resolve are listed for you but not charged.
> - Full delivery: [__] working days from go-ahead.
>
> Delivered as a Google Sheet with your six columns, plus a separate audit file
> holding the source URL, provider and check date for every value — so anything
> can be traced back in seconds.
>
> Happy to run the pilot this week.
>
> [Your name]

---

## Why this reply tends to win

Most applicants to a post like this answer with a price and a promise of 95%
coverage. Three things separate this one:

* **It names a real constraint the client does not know about** (the Proxycurl
  shutdown) and turns it into a request that makes the job cheaper for them.
  That reads as expertise, because it is.
* **It shows a row that was deliberately left blank, and explains why.** Nothing
  else you can put in a proposal signals quality as economically as showing the
  work you refused to fake.
* **It prices what is delivered, not what is attempted.** That removes the
  argument this work reliably produces, and it is only possible because the
  system actually tracks per-row outcomes.

## Before you send

- [ ] Replace every `[…]`.
- [ ] Run a pilot — even 25 rows — so your numbers are yours.
- [ ] Replace the sample table with anonymised rows from that pilot.
- [ ] Re-read the phone paragraph. If you are not willing to hold that line
      under pressure at delivery, do not put it in the proposal.
