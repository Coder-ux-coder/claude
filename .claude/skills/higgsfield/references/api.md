# API reference

Base URL `https://api.higgsfield.ai`. Everything below is what the client
implements; read it when debugging a failure or extending the client.

Official documentation: <https://docs.higgsfield.ai/docs>

## Authentication

```http
Authorization: Key YOUR_KEY_ID:YOUR_KEY_SECRET
```

Keys are created at <https://cloud.higgsfield.ai>. The legacy `hf-api-key` and
`hf-secret` headers still work; new integrations use `Authorization`.

Credentials are **server-side only**. Anyone who can read them can spend the
account's credits. Use separate keys for development and production, and rotate
immediately on any suspected exposure.

### A non-obvious requirement

The API sits behind Cloudflare, which rejects the default `Python-urllib/3.x`
User-Agent with **HTTP 403, error 1010**, before the request reaches the API at
all. Any client must send a named User-Agent. The 403 looks like an
authorization failure but is not one — if `doctor` reports a CDN block, the
agent header is the cause, not the key.

## Request lifecycle

Generation is asynchronous. A submission returns immediately:

```json
{
  "status": "queued",
  "request_id": "d7e6c0f3-...",
  "status_url": "https://api.higgsfield.ai/requests/d7e6c0f3-.../status",
  "cancel_url": "https://api.higgsfield.ai/requests/d7e6c0f3-.../cancel"
}
```

Use the URLs from the response rather than building them by hand.

| Status | Terminal | Meaning |
|---|:--:|---|
| `queued` | no | Waiting to start; still cancellable |
| `in_progress` | no | Running; no longer cancellable |
| `completed` | yes | Output URLs present |
| `failed` | yes | Failed; `error` may explain; **not charged** |
| `nsfw` | yes | Rejected by moderation; **not charged** |
| `canceled` | yes | Cancelled before processing; refunded |

Store `request_id` the moment a request is accepted. It is the only handle for
polling, cancellation, and support.

## Polling

Poll `status_url` until terminal. The client starts at 2s, multiplies by 1.5 up
to a 10s ceiling, and adds jitter.

| Response | Action |
|---|---|
| `200`, non-terminal | Keep polling with backoff |
| `401` | Stop; fix credentials |
| `404` | Stop; wrong request id or account |
| `5xx` or network failure | Retry the status call with backoff |

Webhooks exist for production workloads
(<https://docs.higgsfield.ai/docs/how-to/webhooks>) with polling as the
recovery path. The client polls only; a webhook receiver needs a public
endpoint this repository does not have.

## Completed output

The field depends on the model's output type:

```json
{ "images": [ { "url": "..." }, { "url": "..." } ] }
{ "video":  { "url": "..." } }
{ "audio":  { "url": "..." }, "audios": [ { "url": "..." } ] }
```

Some operations also return `zip`, `mov`, `jsx`, `fbx`, or `ply`. The client
scans all of these.

**Retention: at least seven days.** Copy anything worth keeping to local
storage or Drive. The client's `-o DIR` does this.

## Errors

Errors use the FastAPI envelope, `{"detail": ...}`, where `detail` is a string
or a list of validation objects. Do not parse the prose for control flow.

| Status | Meaning | Retry |
|---|---|---|
| `400` | Bad parameters, rejected input, or concurrency reached | After correcting or waiting |
| `401` | Missing or invalid credentials | No |
| `403` | Insufficient credits | After funding |
| `404` | Request or model not found for this account | No |
| `422` | Body failed validation | No |
| `423` | Model temporarily blocked | Later |
| `500` | Server error | Yes, with backoff |
| `503` | Model disabled or not ready | Later |

Every response carries `X-Correlation-ID`. The client surfaces it on errors;
quote it with the `request_id` when contacting support@higgsfield.ai.

### The retry rule that matters

Submissions do **not** accept an idempotency key. A `POST` that times out
ambiguously may have been accepted. Retrying can bill twice. The client
therefore retries `GET` status calls only, never a generation `POST`.

## Rate limits

The binding constraint is **concurrency** — how many requests may be queued or
processing at once — not requests per second. Exceeding it returns:

```json
{ "detail": "Maximum number of concurrent requests (4) has been reached" }
```

as HTTP `400`. There are no `Retry-After` or rate-limit headers. Your account's
limits are shown in Higgsfield Cloud. Wait for a request to reach a terminal
state before submitting more.

## Billing

Credits, priced per model and parameters. Credits expire one year after they
are added.

```bash
POST /estimate/{model_path}    # same body as the generation call
{ "credits": "1.500", "usd": "0.094" }
```

`failed` and `nsfw` requests are not charged and reserved credits are refunded.
A successfully cancelled queued request is refunded.

## File uploads

For input media not already on a public https URL:

1. `POST /files/generate-upload-url` with `{"content_type": "image/jpeg"}`
   → `{ public_url, upload_url, upload_headers }`
2. `PUT` the bytes to `upload_url` with **every** header from `upload_headers`.
   Never send Higgsfield credentials to the presigned storage URL.
3. Pass `public_url` as `image_url` / `video_url` / `audio_url`.

Upload URLs expire after one hour. The content type must match what was
declared. Supported: `image/jpeg`, `image/jpg`, `image/png`, `image/webp`,
`image/gif`, `audio/wav`, `audio/x-wav`, `video/mp4`.

`higgsfield.py upload FILE` does all three steps; `run --image ./local.jpg`
does it inline.

## Endpoints not in the OpenAPI spec

`/estimate/{model}` and `/files/generate-upload-url` are documented in the
guides but absent from `openapi.json`, so they do not appear in `models.json`.
The client implements them from the documentation. If either changes shape,
that is the first place to look.
