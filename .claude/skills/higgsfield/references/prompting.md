# Prompting

The model choice sets the ceiling; the prompt decides whether you reach it.
These notes are about getting a usable clip on the first or second attempt
rather than the sixth, because every attempt costs credits.

## The shape of a good video prompt

A generation prompt is a **shot description**, not a caption. Four components,
roughly in this order:

1. **Subject and action** — one action, stated plainly
2. **Camera** — the move and the framing
3. **Light and atmosphere** — time of day, quality of light, air
4. **Look** — lens, film stock, grade, or reference register

> slow dolly-in across a textile factory floor, rows of looms in operation,
> workers in motion mid-ground, low golden morning light raking through high
> windows, dust suspended in the beams, 35mm, shallow depth of field,
> documentary grade

Compare with "a factory in Pakistan" — same model, same cost, a fraction of
the result.

### One action per clip

These models render 4–12 seconds. A prompt containing two beats ("she walks in,
**then** turns and speaks") produces either a cut or an incoherent blend. Build
sequences by chaining separate clips and cutting them together, not by
over-loading a single prompt.

### Camera vocabulary the models respond to

`dolly in` · `dolly out` · `slow pan left` · `tilt up` · `crane down` ·
`tracking shot` · `orbit` · `handheld` · `locked off` · `aerial` · `drone push`
· `rack focus` · `close-up` · `wide establishing shot` · `over-the-shoulder`

State the **speed** too: "slow", "gradual", and "creeping" read very
differently from an unqualified move, which tends to come out fast.

### Light and time

`golden hour` · `blue hour` · `overcast diffuse` · `harsh midday sun` ·
`backlit` · `rim light` · `practical lighting` · `neon spill` · `volumetric
light through haze`

## Image-to-video is a different instruction

When you supply an image, **the image fixes the content**. The prompt should
describe only what changes: the motion, the camera, and the passage of time.

- Good: "gentle push-in; the flags shift in a light breeze; clouds drift"
- Wasteful: re-describing the building already visible in the frame
- Counterproductive: describing something absent from the image — the model
  will either ignore it or distort the frame trying to comply

This is the most reliable route to on-brand output, because composition,
logos, and likeness come from the still rather than from chance.

## Audio, on the two models that have it

Sora 2 and Veo 3.1 generate sound natively. Set `generate_audio=true` on Veo
3.1 — it defaults to **false**, so a silent result is usually this parameter,
not a failure.

- Dialogue: put the spoken line in quotation marks. Keep it short enough to
  fit the duration — roughly 12 words in 8 seconds at a natural pace.
- Ambience: name it ("distant loom clatter, muffled conversation")
- Music rarely arrives on request and rarely fits; score in post instead.

## Negative prompts

Available on Kling and Wan as `negative_prompt`. Use them for **recurring
artefacts**, not for style:

> blurry, distorted hands, warped text, extra limbs, flickering, watermark

Do not push style into the negative prompt ("not boring"). It does nothing
useful and consumes attention.

## Prompt enhancement

Several families expose `enhance_prompt` (Higgsfield DoP, Soul) or
`prompt_optimizer` (Hailuo), **on by default**. The service rewrites the prompt
before generation.

Leave it on for short or casual prompts. Turn it **off** when the wording is
deliberate — approved campaign copy, a specific spoken line, or a carefully
tuned prompt you are iterating on — because otherwise the thing you are
iterating on keeps changing underneath you.

## Still images

Soul, Reve, Flux and Nano Banana reward a different register: composition,
subject, lighting, and medium, closer to a photography brief than a shot list.

> editorial photograph, wide shot of a solar installation on a warehouse roof,
> engineer in high-visibility vest inspecting a panel, late afternoon side
> light, clear sky, shot on medium format, natural colour, no post-processing

For text inside an image — signage, titles, a logo lockup — use
`flux-pro/kontext/max/text-to-image`, and keep the string short and in
quotation marks. Every one of these models degrades on long text.

## An iteration loop that does not waste credits

1. Draft the prompt and check the request with `--dry-run` (free).
2. `estimate` the quality tier so you know what the final run costs.
3. Generate once on a **fast tier** to judge framing and motion.
4. Adjust one variable at a time. Changing the camera move and the light
   together tells you nothing about which one helped.
5. Re-run the approved prompt once on the quality tier, at the final aspect
   ratio and resolution.

Keep the prompts that worked. A prompt that produced a good shot is a reusable
asset, and the cheapest way to get a second good shot.
