# Model catalogue

48 models behind one API. They differ in what they take, what they cost, and
what they are good at. `higgsfield.py models` is the live list; this file
explains how to choose between them.

Regenerate the machine-readable catalogue with `scripts/build_models.py`.

## Choosing

**First question: do you need sound?**
Only **Sora 2** and **Veo 3.1** generate native audio (dialogue, effects,
ambience). Every other video model returns silent footage. If the brief
mentions a voice-over, a spoken line, or "with sound", the choice is already
narrowed to those two.

**Second question: do you have a starting image?**
An image-to-video model anchors composition, branding, and likeness far more
reliably than any text prompt. If the user has a photograph, a product shot, or
an approved still, use it. Text-to-video is for when nothing exists yet.

**Third question: draft or final?**
Fast tiers cost a fraction of quality tiers and are visually close enough to
judge framing and motion. Iterate on `fast`/`lite`/`turbo-standard`, then
re-run the approved prompt once on the quality tier.

### By job

| The job | Model | Why |
|---|---|---|
| Spoken-to-camera clip, narrative scene | `sora-2/text-to-video` | Native audio, strong physical coherence, 4/8/12s |
| Same, highest fidelity | `sora-2/text-to-video/pro` | 1080p; markedly more expensive |
| Cinematic shot with ambience | `veo3.1` | Native audio, 1080p, 4/6/8s |
| Cheap iteration on the above | `veo3.1/fast` | Same interface, lower tier |
| Animate a photograph | `higgsfield-ai/dop/standard` | Built for camera motion over a still; `motions` control |
| Same, fastest | `higgsfield-ai/dop/turbo` | Draft tier |
| Morph between two stills | `veo3.1/first-last-frame-to-video` | First and last frame pinned |
| Best-looking silent motion | `kling-video/v2.1/master/image-to-video` | Strongest motion realism; no audio |
| Good motion, lower cost | `kling-video/v2.5-turbo/pro/image-to-video` | The usual working default |
| High-volume b-roll | `bytedance/seedance/v1/lite/text-to-video` | Cheapest per clip; 480/720/1080 |
| Long-ish silent clip | `minimax/hailuo-02/standard/text-to-video` | 6 or 10s |
| Video with a supplied audio track | `wan-25-preview/image-to-video` | Accepts `audio_url` |
| Editorial still, print quality | `higgsfield-ai/soul/standard` | 2K/4K, ten aspect ratios |
| Consistent face across shots | `higgsfield-ai/soul/character` | Character reference id |
| Match an existing visual style | `higgsfield-ai/soul/reference` | Style reference image + strength |
| Edit an existing image | `nano-banana` | Multi-image input, jpeg/png out |
| Fast edit or restyle | `reve/fast/edit`, `reve/fast/remix` | Cheap, quick turnaround |
| Typography and graphic layouts | `flux-pro/kontext/max/text-to-image` | Handles text in image better than most |

### Tier vocabulary

Names encode cost and quality consistently across families:

- `lite` / `fast` / `turbo` — draft tier, lowest cost
- `standard` — the working default
- `pro` — higher fidelity, higher cost
- `master` — top tier (Kling), highest cost

`resolution` and `duration` multiply cost independently of tier. A 12-second
1080p `pro` clip is dramatically more expensive than a 4-second 720p draft.

### Aspect ratios

Set `aspect_ratio` deliberately — it is usually cheaper than re-cropping later.
`16:9` for presentations and YouTube, `9:16` for reels and stories, `1:1` for
feed posts, `21:9` for a cinematic banner. Sora 2 and Veo 3.1 offer only `16:9`
and `9:16`; the image models offer far more.

## Complete reference

Generated from the live OpenAPI specification. `*` marks a required parameter.


### `bytedance/seedance`

**`/bytedance/seedance/v1/lite/image-to-video`** · image-to-video — needs `image_url`

| parameter | accepts |
|---|---|
| `*prompt` | string |
| `duration` | integer, default `5`, 2–12 |
| `*image_url` | string |
| `resolution` | `480` \| `720` \| `1080`, default `1080` |
| `aspect_ratio` | `16:9` \| `9:16` \| `4:3` \| `3:4` \| `1:1` \| `21:9`, default `16:9` |
| `camera_fixed` | boolean, default `False` |

**`/bytedance/seedance/v1/lite/text-to-video`** · text-to-video

| parameter | accepts |
|---|---|
| `*prompt` | string |
| `duration` | integer, default `5`, 2–12 |
| `resolution` | `480` \| `720` \| `1080`, default `720` |
| `aspect_ratio` | `16:9` \| `9:16` \| `4:3` \| `3:4` \| `1:1` \| `21:9`, default `16:9` |
| `camera_fixed` | boolean, default `False` |

**`/bytedance/seedance/v1/pro/fast/image-to-video`** · image-to-video — needs `image_url`

| parameter | accepts |
|---|---|
| `*prompt` | string |
| `duration` | integer, default `5`, 2–12 |
| `*image_url` | string |
| `resolution` | `480` \| `720` \| `1080`, default `1080` |
| `aspect_ratio` | `16:9` \| `9:16` \| `4:3` \| `3:4` \| `1:1` \| `21:9`, default `16:9` |
| `camera_fixed` | boolean, default `False` |

**`/bytedance/seedance/v1/pro/fast/text-to-video`** · text-to-video

| parameter | accepts |
|---|---|
| `*prompt` | string |
| `duration` | integer, default `5`, 2–12 |
| `resolution` | `480` \| `720` \| `1080`, default `1080` |
| `aspect_ratio` | `16:9` \| `9:16` \| `4:3` \| `3:4` \| `1:1` \| `21:9`, default `16:9` |
| `camera_fixed` | boolean, default `False` |


### `flux-pro`

**`/flux-pro/kontext/max/text-to-image`** · text-to-image

| parameter | accepts |
|---|---|
| `seed` | integer, 1–1000000 |
| `*prompt` | string |
| `aspect_ratio` | `16:9` \| `4:3` \| `1:1` \| `3:4` \| `9:16` \| `2:3` \| `1:2` \| `2:1` \| `4:5` \| `3:2`, default `16:9` |
| `safety_tolerance` | integer, default `6`, 0–6 |


### `higgsfield-ai/dop`

**`/higgsfield-ai/dop/lite`** · image-to-video — needs `image_url`

| parameter | accepts |
|---|---|
| `seed` | integer, 1–1000000 |
| `*prompt` | string |
| `motions` | array |
| `*image_url` | string |
| `end_image_url` | string |
| `enhance_prompt` | boolean, default `True` |

**`/higgsfield-ai/dop/standard`** · image-to-video — needs `image_url`

| parameter | accepts |
|---|---|
| `seed` | integer, 1–1000000 |
| `*prompt` | string |
| `motions` | array |
| `*image_url` | string |
| `end_image_url` | string |
| `enhance_prompt` | boolean, default `True` |

**`/higgsfield-ai/dop/turbo`** · image-to-video — needs `image_url`

| parameter | accepts |
|---|---|
| `seed` | integer, 1–1000000 |
| `*prompt` | string |
| `motions` | array |
| `*image_url` | string |
| `end_image_url` | string |
| `enhance_prompt` | boolean, default `True` |


### `higgsfield-ai/popcorn`

**`/higgsfield-ai/popcorn/auto`** · text-to-image

| parameter | accepts |
|---|---|
| `seed` | integer, 1–1000000 |
| `*prompt` | string |
| `image_urls` | array |
| `num_images` | integer, default `1`, 1–8 |
| `resolution` | `720p` \| `1600p`, default `720p` |
| `aspect_ratio` | `1:1` \| `4:3` \| `3:4` \| `3:2` \| `2:3` \| `16:9` \| `9:16`, default `4:3` |


### `higgsfield-ai/soul`

**`/higgsfield-ai/soul/character`** · text-to-image

| parameter | accepts |
|---|---|
| `seed` | integer, 1–1000000 |
| `*prompt` | string |
| `style_id` | string |
| `batch_size` | `1` \| `4`, default `1` |
| `resolution` | `720p` \| `1080p`, default `720p` |
| `aspect_ratio` | `9:16` \| `16:9` \| `4:3` \| `3:4` \| `1:1` \| `2:3` \| `3:2`, default `4:3` |
| `enhance_prompt` | boolean, default `True` |
| `style_strength` | number, default `1`, 0–1 |
| `*custom_reference_id` | string |
| `image_reference_url` | string |
| `*custom_reference_strength` | number, default `1`, 0–1 |

**`/higgsfield-ai/soul/reference`** · image-to-image — needs `image_reference_url`

| parameter | accepts |
|---|---|
| `seed` | integer, 1–1000000 |
| `*prompt` | string |
| `style_id` | string |
| `batch_size` | `1` \| `4`, default `1` |
| `resolution` | `720p` \| `1080p`, default `720p` |
| `aspect_ratio` | `9:16` \| `16:9` \| `4:3` \| `3:4` \| `1:1` \| `2:3` \| `3:2`, default `4:3` |
| `enhance_prompt` | boolean, default `True` |
| `style_strength` | number, default `1`, 0–1 |
| `*image_reference_url` | string |

**`/higgsfield-ai/soul/standard`** · text-to-image

| parameter | accepts |
|---|---|
| `*prompt` | string |
| `num_images` | integer, default `1`, 1–4 |
| `resolution` | `2K` \| `4K`, default `2K` |
| `aspect_ratio` | `1:1` \| `4:3` \| `3:4` \| `3:2` \| `2:3` \| `5:4` \| `4:5` \| `16:9` \| `9:16` \| `21:9`, default `4:3` |


### `kling-video`

**`/kling-video/v2.1/master/image-to-video`** · image-to-video — needs `image_url`

| parameter | accepts |
|---|---|
| `*prompt` | string |
| `duration` | `5` \| `10`, default `5` |
| `cfg_scale` | number, default `0.5`, 0–1 |
| `*image_url` | string |
| `negative_prompt` | string, default `` |

**`/kling-video/v2.1/master/text-to-video`** · text-to-video

| parameter | accepts |
|---|---|
| `*prompt` | string |
| `duration` | `5` \| `10`, default `5` |
| `cfg_scale` | number, default `0.5`, 0–1 |
| `aspect_ratio` | `1:1` \| `16:9` \| `9:16`, default `1:1` |
| `negative_prompt` | string, default `` |

**`/kling-video/v2.1/pro/image-to-video`** · image-to-video — needs `image_url`

| parameter | accepts |
|---|---|
| `*prompt` | string |
| `duration` | `5` \| `10`, default `5` |
| `cfg_scale` | number, default `0.5`, 0–1 |
| `*image_url` | string |
| `negative_prompt` | string, default `` |

**`/kling-video/v2.1/standard/image-to-video`** · image-to-video — needs `image_url`

| parameter | accepts |
|---|---|
| `*prompt` | string |
| `duration` | `5` \| `10`, default `5` |
| `cfg_scale` | number, default `0.5`, 0–1 |
| `*image_url` | string |
| `negative_prompt` | string, default `` |

**`/kling-video/v2.5-turbo/pro/image-to-video`** · image-to-video — needs `image_url`

| parameter | accepts |
|---|---|
| `*prompt` | string |
| `duration` | `5` \| `10`, default `5` |
| `cfg_scale` | number, default `0.5`, 0–1 |
| `*image_url` | string |
| `negative_prompt` | string, default `` |

**`/kling-video/v2.5-turbo/pro/text-to-video`** · text-to-video

| parameter | accepts |
|---|---|
| `*prompt` | string |
| `duration` | `5` \| `10`, default `5` |
| `cfg_scale` | number, default `0.5`, 0–1 |
| `negative_prompt` | string, default `` |

**`/kling-video/v2.5-turbo/standard/image-to-video`** · image-to-video — needs `image_url`

| parameter | accepts |
|---|---|
| `*prompt` | string |
| `duration` | `5` \| `10`, default `5` |
| `cfg_scale` | number, default `0.5`, 0–1 |
| `*image_url` | string |
| `negative_prompt` | string, default `` |


### `minimax`

**`/minimax/hailuo-02/pro/image-to-video`** · image-to-video — needs `image_url`

| parameter | accepts |
|---|---|
| `*prompt` | string |
| `*image_url` | string |
| `end_image_url` | string |
| `prompt_optimizer` | boolean, default `True` |

**`/minimax/hailuo-02/pro/text-to-video`** · text-to-video

| parameter | accepts |
|---|---|
| `*prompt` | string |
| `prompt_optimizer` | boolean, default `True` |

**`/minimax/hailuo-02/standard/image-to-video`** · image-to-video — needs `image_url`

| parameter | accepts |
|---|---|
| `*prompt` | string |
| `duration` | `6` \| `10`, default `6` |
| `*image_url` | string |
| `resolution` | `512P` \| `768P`, default `768P` |
| `end_image_url` | string |
| `prompt_optimizer` | boolean, default `True` |

**`/minimax/hailuo-02/standard/text-to-video`** · text-to-video

| parameter | accepts |
|---|---|
| `*prompt` | string |
| `duration` | `6` \| `10`, default `6` |
| `prompt_optimizer` | boolean, default `True` |

**`/minimax/hailuo-2.3-fast/pro/image-to-video`** · image-to-video — needs `image_url`

| parameter | accepts |
|---|---|
| `*prompt` | string |
| `*image_url` | string |
| `prompt_optimizer` | boolean, default `True` |

**`/minimax/hailuo-2.3-fast/standard/image-to-video`** · image-to-video — needs `image_url`

| parameter | accepts |
|---|---|
| `*prompt` | string |
| `duration` | `6` \| `10`, default `6` |
| `*image_url` | string |
| `prompt_optimizer` | boolean, default `True` |

**`/minimax/hailuo-2.3/pro/image-to-video`** · image-to-video — needs `image_url`

| parameter | accepts |
|---|---|
| `*prompt` | string |
| `*image_url` | string |
| `prompt_optimizer` | boolean, default `True` |

**`/minimax/hailuo-2.3/pro/text-to-video`** · text-to-video

| parameter | accepts |
|---|---|
| `*prompt` | string |
| `prompt_optimizer` | boolean, default `True` |

**`/minimax/hailuo-2.3/standard/image-to-video`** · image-to-video — needs `image_url`

| parameter | accepts |
|---|---|
| `*prompt` | string |
| `duration` | `6` \| `10`, default `6` |
| `*image_url` | string |
| `prompt_optimizer` | boolean, default `True` |

**`/minimax/hailuo-2.3/standard/text-to-video`** · text-to-video

| parameter | accepts |
|---|---|
| `*prompt` | string |
| `duration` | `6` \| `10`, default `6` |
| `prompt_optimizer` | boolean, default `True` |


### `nano-banana`

**`/nano-banana`** · text-to-image

| parameter | accepts |
|---|---|
| `*prompt` | string |
| `num_images` | integer, default `1`, 1–4 |
| `aspect_ratio` | `auto` \| `1:1` \| `4:3` \| `3:4` \| `3:2` \| `2:3` \| `5:4` \| `4:5` \| `16:9` \| `9:16` \| `21:9`, default `4:3` |
| `input_images` | array |
| `output_format` | `jpeg` \| `png`, default `jpeg` |


### `reve`

**`/reve/edit`** · image-to-image — needs `image_url`

| parameter | accepts |
|---|---|
| `*prompt` | string |
| `*image_url` | string |
| `num_images` | integer, default `1`, 1–4 |

**`/reve/fast/edit`** · image-to-image — needs `image_url`

| parameter | accepts |
|---|---|
| `*prompt` | string |
| `*image_url` | string |
| `num_images` | integer, default `1`, 1–4 |

**`/reve/fast/remix`** · image-to-image — needs `image_urls`

| parameter | accepts |
|---|---|
| `*prompt` | string |
| `*image_urls` | array |
| `num_images` | integer, default `1`, 1–4 |
| `aspect_ratio` | `1:1` \| `4:3` \| `3:4` \| `3:2` \| `2:3` \| `5:4` \| `4:5` \| `16:9` \| `9:16`, default `4:3` |

**`/reve/remix`** · image-to-image — needs `image_urls`

| parameter | accepts |
|---|---|
| `*prompt` | string |
| `*image_urls` | array |
| `num_images` | integer, default `1`, 1–4 |
| `aspect_ratio` | `1:1` \| `4:3` \| `3:4` \| `3:2` \| `2:3` \| `5:4` \| `4:5` \| `16:9` \| `9:16`, default `4:3` |

**`/reve/text-to-image`** · text-to-image

| parameter | accepts |
|---|---|
| `*prompt` | string |
| `num_images` | integer, default `1`, 1–4 |


### `sora-2`

**`/sora-2/image-to-video`** · text-to-video

| parameter | accepts |
|---|---|
| `*prompt` | string |
| `duration` | `4` \| `8` \| `12`, default `4` |
| `image_url` | string |
| `resolution` | `720p`, default `720p` |
| `aspect_ratio` | `16:9` \| `9:16`, default `16:9` |

**`/sora-2/image-to-video/pro`** · image-to-video — needs `image_url`

| parameter | accepts |
|---|---|
| `*prompt` | string |
| `duration` | `4` \| `8` \| `12`, default `4` |
| `*image_url` | string |
| `resolution` | `720p` \| `1080p`, default `720p` |
| `aspect_ratio` | `16:9` \| `9:16`, default `16:9` |

**`/sora-2/text-to-video`** · text-to-video

| parameter | accepts |
|---|---|
| `*prompt` | string |
| `duration` | `4` \| `8` \| `12`, default `4` |
| `resolution` | `720p`, default `720p` |
| `aspect_ratio` | `16:9` \| `9:16`, default `16:9` |

**`/sora-2/text-to-video/pro`** · text-to-video

| parameter | accepts |
|---|---|
| `*prompt` | string |
| `duration` | `4` \| `8` \| `12`, default `4` |
| `resolution` | `720p` \| `1080p`, default `720p` |
| `aspect_ratio` | `16:9` \| `9:16`, default `16:9` |


### `veo3.1`

**`/veo3.1`** · text-to-video

| parameter | accepts |
|---|---|
| `*prompt` | string |
| `duration` | `4` \| `6` \| `8`, default `6` |
| `*resolution` | `720` \| `1080`, default `720` |
| `*aspect_ratio` | `16:9` \| `9:16`, default `16:9` |
| `*generate_audio` | boolean, default `False` |

**`/veo3.1/fast`** · text-to-video

| parameter | accepts |
|---|---|
| `*prompt` | string |
| `duration` | `4` \| `6` \| `8`, default `6` |
| `*resolution` | `720` \| `1080`, default `720` |
| `*aspect_ratio` | `16:9` \| `9:16`, default `16:9` |
| `*generate_audio` | boolean, default `False` |

**`/veo3.1/fast/first-last-frame-to-video`** · image-to-video — needs `first_frame_url`, `last_frame_url`

| parameter | accepts |
|---|---|
| `*prompt` | string |
| `duration` | `4` \| `6` \| `8`, default `6` |
| `resolution` | `720` \| `1080`, default `720` |
| `aspect_ratio` | `16:9` \| `9:16`, default `16:9` |
| `generate_audio` | boolean, default `False` |
| `*last_frame_url` | string |
| `*first_frame_url` | string |

**`/veo3.1/fast/image-to-video`** · image-to-video — needs `image_url`

| parameter | accepts |
|---|---|
| `*prompt` | string |
| `duration` | `4` \| `6` \| `8`, default `6` |
| `*image_url` | string |
| `resolution` | `720` \| `1080`, default `720` |
| `aspect_ratio` | `16:9` \| `9:16`, default `16:9` |
| `generate_audio` | boolean, default `False` |

**`/veo3.1/first-last-frame-to-video`** · image-to-video — needs `first_frame_url`, `last_frame_url`

| parameter | accepts |
|---|---|
| `*prompt` | string |
| `duration` | `4` \| `6` \| `8`, default `6` |
| `resolution` | `720` \| `1080`, default `720` |
| `aspect_ratio` | `16:9` \| `9:16`, default `16:9` |
| `generate_audio` | boolean, default `False` |
| `*last_frame_url` | string |
| `*first_frame_url` | string |

**`/veo3.1/image-to-video`** · image-to-video — needs `image_url`

| parameter | accepts |
|---|---|
| `*prompt` | string |
| `duration` | `4` \| `6` \| `8`, default `6` |
| `*image_url` | string |
| `resolution` | `720` \| `1080`, default `720` |
| `aspect_ratio` | `16:9` \| `9:16`, default `16:9` |
| `generate_audio` | boolean, default `False` |

**`/veo3.1/reference-to-video`** · image-to-video — needs `image_urls`

| parameter | accepts |
|---|---|
| `*prompt` | string |
| `duration` | `4` \| `6` \| `8`, default `6` |
| `*image_urls` | array |
| `resolution` | `720` \| `1080`, default `720` |
| `aspect_ratio` | `16:9` \| `9:16`, default `16:9` |
| `generate_audio` | boolean, default `False` |


### `wan-25-preview`

**`/wan-25-preview/image-to-video`** · image-to-video — needs `image_url`

| parameter | accepts |
|---|---|
| `seed` | integer, default `-1`, -1–1000000 |
| `*prompt` | string |
| `duration` | `5` \| `10`, default `5` |
| `audio_url` | string |
| `*image_url` | string |
| `resolution` | `480p` \| `720p` \| `1080p`, default `720p` |
| `negative_prompt` | string, default `` |

**`/wan-25-preview/text-to-video`** · text-to-video

| parameter | accepts |
|---|---|
| `seed` | integer, default `-1`, -1–1000000 |
| `*prompt` | string |
| `duration` | `5` \| `10`, default `5` |
| `audio_url` | string |
| `resolution` | `480p` \| `720p` \| `1080p`, default `720p` |
| `negative_prompt` | string, default `` |

