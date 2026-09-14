---
name: higgsfield
description: Generate video and images through the Higgsfield API - text-to-video, image-to-video, text-to-image, and image editing across Sora 2, Veo 3.1, Kling, Hailuo, Seedance, Soul and DoP. Use when the user wants to create or animate video or imagery, produce promotional or campaign footage, turn a photograph into a moving shot, generate b-roll or social clips, or asks about Higgsfield models, credentials, costs or a running generation request.
---

# Higgsfield Generation

One authenticated, asynchronous API in front of 48 image and video models.
The client measures, validates and polls. **You choose the model and write the
prompt** — that is where the judgement lives, and where the credits are spent.

```
intent ─> model choice ─> estimate ─> submit ─> poll ─> download
          YOU             cost        client   client   client
```

## Before anything else

```bash
python3 .claude/skills/higgsfield/scripts/higgsfield.py doctor
```

This checks the catalogue, the credentials and the network in one pass. If it
reports `NOT CONFIGURED`, the user needs a key from
<https://cloud.higgsfield.ai> — see "Credentials" below. **Do not attempt
generation until `doctor` is clean**; every failure mode after that point costs
either time or credits.

## Spending discipline

Generation costs real money, and the account has a hard **concurrency** limit,
not a rate limit. Three rules:

1. **Estimate before a first-of-its-kind request.** `estimate` takes the same
   parameters as `run` and returns credits and USD. Video is far more expensive
   than images, and `pro`/`master`/`1080p` tiers multiply it.
2. **Never resubmit after an ambiguous timeout.** The API has no idempotency
   key, so a blind retry can bill twice. If a submission's outcome is unclear,
   find the `request_id` and call `status` — never `run` again.
3. **Draft cheap, finish expensive.** Block out the shot on a fast tier
   (`veo3.1/fast`, `kling-video/v2.5-turbo/standard`, `seedance/v1/lite`),
   confirm the framing, then re-run the approved prompt on the quality tier.

`failed` and `nsfw` requests are **not** charged, and reserved credits are
refunded. A timeout on your side is not a cancellation — the job keeps running
and will still bill.

## Workflow

### 1. Choose the model

This is the decision that matters. Read `references/models.md` for the full
selection guide; the short form:

| Need | Reach for |
|---|---|
| Dialogue, sound, narrative shot | `sora-2/text-to-video` or `veo3.1` (both do native audio) |
| Animate an existing photograph | `higgsfield-ai/dop/standard` (camera-motion control) |
| Cinematic motion, no audio needed | `kling-video/v2.5-turbo/pro/image-to-video` |
| Cheap volume / drafts | `bytedance/seedance/v1/lite/*`, `veo3.1/fast` |
| Stills, editorial quality | `higgsfield-ai/soul/standard` (2K/4K) |
| Edit or restyle an existing image | `nano-banana`, `reve/edit` |
| Keep a face consistent across shots | `higgsfield-ai/soul/character` |

```bash
higgsfield.py models --output video --family veo3.1   # what exists
higgsfield.py show veo3.1/image-to-video              # what it takes
```

Model names resolve from any unique fragment, so `show soul/standard` works.

### 2. Estimate

```bash
higgsfield.py estimate veo3.1 --prompt "..." -p duration=8 -p resolution=1080
```

Report the cost to the user before running anything expensive or anything
iterated in bulk.

### 3. Run

```bash
higgsfield.py run veo3.1/image-to-video \
  --prompt "slow dolly-in across the factory floor, warm morning light" \
  --image ./site-photo.jpg \
  -p duration=8 -p resolution=1080 -p generate_audio=true \
  -o ./out
```

`run` submits, polls with backoff, and downloads. `--image` accepts an https
URL or a **local file**, which it uploads first. Parameters not given fall back
to the schema's defaults, so only state what you actually want to control.

Use `--dry-run` to inspect the exact request body without sending it. Dry runs
need no credentials, so they are a safe way to check a command before it costs
anything.

For long video, submit and detach instead of holding the terminal:

```bash
ID=$(higgsfield.py submit sora-2/text-to-video/pro --prompt "..." -p duration=12)
higgsfield.py wait "$ID" -o ./out
```

### 4. Save the output

**Output URLs expire after about seven days.** Always pass `-o DIR` for
anything the user intends to keep, and tell them where the files landed. A URL
in the chat transcript is not a deliverable.

## Writing the prompt

The prompt is the product. `references/prompting.md` has the detail; the
essentials:

- **Describe the shot, not just the subject.** Camera move, lens, light and
  pace are what separate a usable clip from a generic one: "slow push-in,
  35mm, low golden light, dust in the air" beats "a factory".
- **One action per clip.** These models render 4-12 seconds. A second beat in
  the prompt produces a cut or a mess, not a sequence. Build sequences by
  chaining clips, not by over-loading one prompt.
- **Image-to-video prompts describe motion, not content.** The image already
  fixes the content; the prompt should say what moves and how.
- **Negative prompts** (`negative_prompt`) exist on Kling and Wan. Use them for
  recurring artefacts, not for style.
- Some models take `enhance_prompt` / `prompt_optimizer`, on by default. Turn
  it off when the user's wording is deliberate and must be preserved.

## Handling terminal states

| Status | What it means | What to do |
|---|---|---|
| `completed` | Media is ready | Download it; the URL expires |
| `failed` | Generation failed, not charged | Report the `error` field; retry once if it looks transient |
| `nsfw` | Moderation rejected input or output, not charged | Say so plainly and rephrase; do not loop trying to defeat the filter |
| `canceled` | Cancelled before processing | Refunded |

HTTP `400` with "Maximum number of concurrent requests" is the concurrency
ceiling, not an error in the request — wait for a running job to finish. `403`
means the account is out of credits.

## Credentials

Read from, in order: `HF_API_KEY_ID` + `HF_API_KEY_SECRET`, or `HF_KEY` in
`key-id:key-secret` form, or a `.env` file found by searching upward from the
repository.

**Never write credentials into a file that is tracked by git, a commit
message, a prompt, or the transcript.** `.env` is gitignored; `.env.example`
shows the shape without the values. The client redacts secrets from its own
error output, but it cannot redact what gets typed into a chat.

Credentials are server-side only. Do not put them in browser or mobile code.

## Regenerating the catalogue

`models.json` is generated from Higgsfield's live OpenAPI spec, so validation
cannot drift from the real API:

```bash
python3 .claude/skills/higgsfield/scripts/build_models.py           # refresh
python3 .claude/skills/higgsfield/scripts/build_models.py --check   # is it stale?
```

Run it when a model the user names is missing, or when the API rejects a
parameter the catalogue accepts.

## Validating the integration

```bash
python3 .claude/skills/higgsfield/scripts/selfcheck.py          # offline, 46 checks
python3 .claude/skills/higgsfield/scripts/selfcheck.py --live   # + reachability
```

Nothing is generated and no credits are spent. Run it after changing the client
or refreshing the catalogue.

## References

| File | Contents |
|---|---|
| `references/models.md` | All 48 models, what each is for, how to choose |
| `references/api.md` | Lifecycle, auth, errors, limits, billing, retention |
| `references/prompting.md` | Prompt construction per model family |
